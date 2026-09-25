/** Semantic Versioning 2.0 and the range grammar of spec/0.1/versioning.md. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence: negative, zero or positive. Build metadata is ignored. */
export function compareVersions(a: Version, b: Version): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = compareIdentifiers(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

interface Bounds {
  lower: Version;
  upper?: Version;
  inclusiveUpper?: boolean;
}

const RANGE =
  /^(?:(\*)|(\d+)(?:\.(\d+))?|\^(\d+)\.(\d+)|([\^~]?)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/;

const v = (major: number, minor: number, patch: number, prerelease: string[] = []): Version => ({
  major,
  minor,
  patch,
  prerelease,
});

function nextBreaking(x: Version): Version {
  if (x.major > 0) return v(x.major + 1, 0, 0);
  if (x.minor > 0) return v(0, x.minor + 1, 0);
  return v(0, 0, x.patch + 1);
}

function bounds(range: string): Bounds | "any" | undefined {
  const m = RANGE.exec(range);
  if (!m) return undefined;
  if (m[1]) return "any";
  if (m[2] !== undefined) {
    const major = Number(m[2]);
    if (m[3] === undefined) return { lower: v(major, 0, 0), upper: v(major + 1, 0, 0) };
    const minor = Number(m[3]);
    return { lower: v(major, minor, 0), upper: v(major, minor + 1, 0) };
  }
  if (m[4] !== undefined) {
    const lower = v(Number(m[4]), Number(m[5]), 0);
    return { lower, upper: nextBreaking(lower) };
  }
  const lower = v(Number(m[7]), Number(m[8]), Number(m[9]), m[10] ? m[10].split(".") : []);
  if (m[6] === "^") return { lower, upper: nextBreaking(lower) };
  if (m[6] === "~") return { lower, upper: v(lower.major, lower.minor + 1, 0) };
  return { lower, upper: lower, inclusiveUpper: true };
}

export function isValidRange(range: string): boolean {
  return bounds(range) !== undefined;
}

/** Whether `version` satisfies `range` (spec/0.1/versioning.md §3). */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const b = bounds(range);
  if (!parsed || !b) return false;
  if (b === "any") return parsed.prerelease.length === 0;
  if (parsed.prerelease.length > 0) {
    const sameCore =
      b.lower.prerelease.length > 0 &&
      b.lower.major === parsed.major &&
      b.lower.minor === parsed.minor &&
      b.lower.patch === parsed.patch;
    if (!sameCore) return false;
  }
  if (compareVersions(parsed, b.lower) < 0) return false;
  if (!b.upper) return true;
  const upper = compareVersions(parsed, b.upper);
  return b.inclusiveUpper ? upper <= 0 : upper < 0;
}
