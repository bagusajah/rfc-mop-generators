// Italicizes untranslated English technical terms/jargon inside generated
// .docx body text — the Indonesian technical-writing convention for foreign
// words. Two-step, no template changes needed:
//   1. markItalicTerms() wraps matches in sentinel chars (private-use-area,
//      never occurs in real text) before the value reaches docxtemplater —
//      called from each app's template-data.js on narrative fields.
//   2. applyItalicMarkers() runs AFTER doc.render(), splitting any run whose
//      <w:t> contains a marked span into separate runs (italic + non-italic),
//      cloning the original run's <w:rPr> so size/font stay exactly as the
//      template defines them. Runs without markers are left byte-identical.
//
// Add new jargon by extending TECH_TERMS — no other code changes needed.
const TECH_TERMS = [
  // infra / ops
  "server", "database", "backend", "frontend", "framework", "endpoint",
  "load balancer", "firewall", "gateway", "patch", "config", "configuration",
  "container", "cluster", "node", "pipeline", "staging", "production",
  "sandbox", "environment", "script", "query", "cache", "token", "session",
  "cookie", "middleware", "microservice", "monolith", "repository", "commit",
  "branch", "merge", "pull request", "changelog", "release", "hotfix", "bug",
  "feature", "deployment", "deploy", "rollback", "downtime", "uptime",
  "maintenance window", "cutover", "go-live", "provisioning", "orchestration",
  "virtualization", "hypervisor", "instance", "bare metal", "on-premise",
  "cloud", "hybrid cloud", "multi-cloud", "storage", "volume", "bucket",
  "object storage", "block storage", "subnet", "proxy", "reverse proxy",
  "certificate", "domain", "subdomain", "hostname", "port", "protocol",
  "request", "response", "payload", "header", "status code", "error code",
  "exception", "stack trace", "debug", "debugging", "log file", "timestamp",
  "checksum", "encryption key", "access key", "secret key",
  "least privilege", "zero trust", "patch management", "vulnerability",
  "exploit", "penetration test", "pentest", "malware", "ransomware",
  "phishing", "rate limiting", "throttling", "circuit breaker", "retry",
  "timeout", "idempotent", "asynchronous", "synchronous", "batch job",
  "real-time", "streaming", "event-driven", "message queue", "scheduler",
  "queue", "broker", "replica", "snapshot", "backup", "restore", "failover",
  "load test", "stress test", "unit test", "integration test",
  "regression test", "smoke test", "sanity check", "single point of failure",
  "root cause", "postmortem", "runbook", "playbook",
  "standard operating procedure", "go/no-go", "sign-off", "stakeholder",
  "change advisory board", "freeze period", "blackout period",
  "maintenance mode", "feature flag", "canary release",
  "blue-green deployment", "capacity planning", "scaling", "autoscaling",
  "horizontal scaling", "vertical scaling", "monitoring", "logging",
  "dashboard", "alert", "incident", "outage", "latency", "throughput",
  "bandwidth", "encryption", "authentication", "authorization", "credential",
  "username", "login", "logout", "webhook", "cronjob",
  // acronyms
  "API", "SLA", "DNS", "VPN", "VPC", "SSL", "TLS", "IP address", "UUID",
  "IAM", "RBAC", "DDoS", "RCA", "SPOF", "CAB", "CI/CD", "VM",
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest-first so multi-word phrases win over their component words
// (e.g. "load balancer" before "load").
const TERM_RE = new RegExp(
  `\\b(?:${[...TECH_TERMS].sort((a, b) => b.length - a.length).map(escapeRegex).join("|")})\\b`,
  "gi",
);

const MARK_OPEN = "";
const MARK_CLOSE = "";

export function markItalicTerms(text) {
  return String(text ?? "").replace(TERM_RE, (m) => `${MARK_OPEN}${m}${MARK_CLOSE}`);
}

const SPLIT_RE = new RegExp(`(${MARK_OPEN}[^${MARK_CLOSE}]*${MARK_CLOSE})`);

const addItalic = (rPr) => {
  if (!rPr) return "<w:rPr><w:i/><w:iCs/></w:rPr>";
  if (rPr === "<w:rPr/>") return "<w:rPr><w:i/><w:iCs/></w:rPr>";
  return rPr.replace("<w:rPr>", "<w:rPr><w:i/><w:iCs/>");
};

// Matches a single-run "<w:r>[<w:rPr>...</w:rPr>]<w:t ...>text</w:t></w:r>"
// block — the shape docxtemplater emits for a plain-text tag substitution.
const RUN_RE = /<w:r>(<w:rPr\/>|<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t((?:\s+[\w:.-]+="[^"]*")*)>([\s\S]*?)<\/w:t><\/w:r>/g;

function splitRun(rPr, attrs, text) {
  return text
    .split(SPLIT_RE)
    .filter(Boolean)
    .map((seg) => {
      const italic = seg.startsWith(MARK_OPEN);
      const clean = italic ? seg.slice(1, -1) : seg;
      const runRPr = italic ? addItalic(rPr) : (rPr || "");
      const preserve = /xml:space=/.test(attrs) ? "" : ' xml:space="preserve"';
      return `<w:r>${runRPr}<w:t${attrs}${preserve}>${clean}</w:t></w:r>`;
    })
    .join("");
}

function applyItalicMarkersToXml(xml) {
  return xml.replace(RUN_RE, (whole, rPr, attrs, text) =>
    text.includes(MARK_OPEN) ? splitRun(rPr, attrs, text) : whole);
}

// Rewrites every body/header/footer part of a rendered PizZip in place.
export function applyItalicMarkers(zip) {
  for (const file of zip.file(/^word\/(document|header\d*|footer\d*)\.xml$/)) {
    zip.file(file.name, applyItalicMarkersToXml(file.asText()));
  }
}
