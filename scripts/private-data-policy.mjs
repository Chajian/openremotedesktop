// Heuristic review for newly added public-repository text. Never print matched values.
// Product domains intentionally public to users are reviewed, not inferred from a regex.
function reservedExampleIp(a, b, c) {
  return (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function placeholderHost(host) {
  const value = host.toLowerCase();
  return value === "localhost" || value === "example.com" ||
    /\.(?:example|test|invalid)$/.test(value) ||
    /\.example\.com$/.test(value);
}

export function privateInformationKinds(line) {
  const kinds = new Set();
  const ipRegex = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
  for (const match of line.matchAll(ipRegex)) {
    const [a, b, c, d] = match.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) continue;
    if (a === 0 || a === 127 || a >= 224 || reservedExampleIp(a, b, c)) continue;
    kinds.add("non-example IP address");
  }
  const emailRegex = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
  for (const match of line.matchAll(emailRegex)) {
    if (!placeholderHost(match[1])) kinds.add("non-example email address");
  }
  const windowsHome = /\b[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+[\\/]/i;
  const unixHome = /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|\b)/;
  if (windowsHome.test(line) || unixHome.test(line)) kinds.add("personal home path");

  const remoteLogin = /\b(?:ssh|sftp|scp)\b[^\n]{0,100}?\b[A-Za-z_][A-Za-z0-9_-]*@([A-Za-z0-9.-]+)/i.exec(line);
  if (remoteLogin && !placeholderHost(remoteLogin[1])) kinds.add("remote server login");
  if (/\b(?:[a-z0-9-]+\.)+(?:internal|lan|local)\b/i.test(line)) {
    kinds.add("private infrastructure hostname");
  }
  const labeledPhone = /(?:phone|mobile|手机号|联系电话|电话)\s*[:=：]\s*\+?[0-9 ()-]{8,}/i;
  if (labeledPhone.test(line)) kinds.add("personal contact number");
  return [...kinds];
}

export function privateOperationsPath(name) {
  const normalized = name.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  if (segments.some((part) => [".private", "ops-private", "server-private", "server-inventory", "private-deployment"].includes(part))) return true;
  return /\.(?:tfstate(?:\..+)?|tfvars|rdp|ovpn)$/.test(normalized);
}

export function privacyFindingsInDiff(patch) {
  const issues = new Set();
  let file = "<unknown>";
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    if (!line.startsWith("+") || line.startsWith("+++ ")) continue;
    for (const kind of privateInformationKinds(line.slice(1))) {
      issues.add(`${file} (${kind})`);
    }
  }
  return [...issues];
}
