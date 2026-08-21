const QUOTA_WORDS = [
  "insufficient_quota",
  "insufficient quota",
  "quota exceeded",
  "quota_exceeded",
  "insufficient balance",
  "balance is insufficient",
  "余额不足",
  "credit balance",
  "billing"
];

function bodyText(body) {
  if (!body) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function includesText(values, haystack) {
  return Array.isArray(values)
    && values.some((value) => typeof value === "string" && haystack.includes(value.toLowerCase()));
}

function includesStatus(values, status) {
  return Array.isArray(values) && values.includes(status);
}

function includesCode(values, code) {
  return Array.isArray(values)
    && values.some((value) => String(value).toLowerCase() === code.toLowerCase());
}

export function extractErrorInfo(body) {
  if (!body) {
    return { code: "", message: "" };
  }
  if (typeof body === "string") {
    try {
      return extractErrorInfo(JSON.parse(body));
    } catch {
      return { code: "", message: body };
    }
  }
  if (typeof body === "object") {
    const error = body.error ?? body;
    return {
      code: String(error.code ?? error.type ?? ""),
      message: String(error.message ?? error.msg ?? error.detail ?? "")
    };
  }
  return { code: "", message: String(body) };
}

function classification(kind, status, info, overrides = {}) {
  const defaults = {
    credential_permanent: {
      retryable: true,
      rotateKey: true,
      cooldown: "auth",
      code: info.code || `http_${status}`,
      message: info.message || "Upstream credential was rejected"
    },
    billing_or_quota: {
      retryable: true,
      rotateKey: true,
      cooldown: "billing",
      code: info.code || "quota_exhausted",
      message: info.message || "Upstream billing or quota failure"
    },
    rate_limited: {
      retryable: true,
      rotateKey: true,
      cooldown: "rate_limited",
      code: info.code || "rate_limited",
      message: info.message || "Upstream rate limit reached"
    },
    upstream_transient: {
      retryable: true,
      rotateKey: false,
      cooldown: "transient",
      code: info.code || `http_${status}`,
      message: info.message || "Upstream temporary failure"
    },
    request_or_capability: {
      retryable: false,
      rotateKey: false,
      cooldown: null,
      code: info.code || `http_${status}`,
      message: info.message || "Upstream rejected the request"
    }
  };
  return {
    kind,
    status,
    ...defaults[kind],
    ...overrides
  };
}

function providerRuleKind({ rules, status, info, haystack }) {
  if (!rules) {
    return null;
  }
  if (includesStatus(rules.non_retryable_statuses, status)) {
    return "request_or_capability";
  }
  if (
    includesStatus(rules.auth_statuses, status)
    || includesCode(rules.auth_codes, info.code)
    || includesText(rules.auth_messages, haystack)
  ) {
    return "credential_permanent";
  }
  if (
    includesStatus(rules.billing_statuses, status)
    || includesCode(rules.billing_codes, info.code)
    || includesText(rules.billing_messages, haystack)
  ) {
    return "billing_or_quota";
  }
  if (
    includesStatus(rules.rate_limit_statuses, status)
    || includesCode(rules.rate_limit_codes, info.code)
    || includesText(rules.rate_limit_messages, haystack)
  ) {
    return "rate_limited";
  }
  if (
    includesStatus(rules.transient_statuses, status)
    || includesCode(rules.transient_codes, info.code)
    || includesText(rules.transient_messages, haystack)
  ) {
    return "upstream_transient";
  }
  return null;
}

export function classifyUpstreamFailure({ status, body, headers = {}, rules = null }) {
  const info = extractErrorInfo(body);
  const haystack = `${info.code} ${info.message} ${bodyText(body)}`.toLowerCase();
  const retryAfter = headers.get?.("retry-after") ?? headers["retry-after"] ?? null;
  const providerKind = providerRuleKind({ rules, status, info, haystack });

  if (providerKind) {
    const extra = providerKind === "rate_limited" ? { retryAfter } : {};
    return classification(providerKind, status, info, extra);
  }

  if (status === 401 || status === 403) {
    return classification("credential_permanent", status, info);
  }
  if (status === 402 || QUOTA_WORDS.some((word) => haystack.includes(word))) {
    return classification("billing_or_quota", status, info);
  }
  if (status === 429) {
    return classification("rate_limited", status, info, { retryAfter });
  }
  if (status === 408 || status >= 500) {
    return classification("upstream_transient", status, info);
  }
  return classification("request_or_capability", status, info);
}

export function classifyNetworkFailure(error) {
  return {
    kind: "upstream_transient",
    retryable: true,
    rotateKey: false,
    cooldown: "transient",
    status: 502,
    code: error?.name === "AbortError" ? "upstream_timeout" : "upstream_network_error",
    message: error?.message || "Upstream network failure"
  };
}

export function cooldownDuration(classification, routing) {
  if (!classification.cooldown) {
    return 0;
  }
  if (classification.retryAfter) {
    const seconds = Number(classification.retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
  }
  return routing.cooldowns[`${classification.cooldown}_ms`] ?? 0;
}
