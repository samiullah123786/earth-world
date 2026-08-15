/**
 * The Kernel's own deterministic safety scanner.
 *
 * Until this existed, the Kernel took the connector's verdict on faith: a
 * client SAID a deposit was inert and the vault believed it. For a public
 * marketplace that is the hole - a hostile client lies once and ships anything.
 * The Kernel now re-reads the bytes it actually holds, and "Earth Verified"
 * means THIS scan passed, not that somebody claimed one did.
 *
 * It is a line-for-line port of the connector's scanner (earth_cli/safety.py),
 * same rule names and same verdicts, so the two sides agree about the same
 * bytes; the connector's copy remains useful as the fast local pre-check. No
 * model judges any of this: a verdict must be reproducible, explainable, and
 * must name the exact line that caused it.
 *
 * Version 2 adds two rules to both sides:
 *   bidi_override  - Unicode direction controls that make displayed text lie
 *                    about its own order (the "trojan source" shape)
 *   tool_shadowing - MCP-style tool descriptions that instruct an agent to
 *                    prefer, avoid, or intercept OTHER tools
 */

export const SCANNER_VERSION = 'earth-safety-2';

const INERT_SUFFIXES = new Set(['.md', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml',
  '.csv', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const EXECUTABLE_SUFFIXES = new Set(['.py', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php',
  '.exe', '.dll', '.so', '.dylib', '.jar', '.bin', '.msi']);
const CONFIG_NAMES = new Set(['settings.json', 'settings.local.json', '.mcp.json', 'mcp.json',
  'hooks.json', 'claude.json', '.claude.json', 'config.toml']);
const TEXT_SCAN_SUFFIXES = new Set(['.py', '.sh', '.ps1', '.js', '.ts']);

export const MAX_FILES = 5_000;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type Finding = {
  rule: string;
  // "capability" states what a deposit needs in order to work. It is reported
  // on the listing and never counts against the verdict.
  severity: 'refuse' | 'review' | 'capability';
  where: string;
  detail: string;
  line: number;
};

export type ScanVerdict = {
  verdict: 'inert_safe' | 'needs_review' | 'refused';
  flags: string[];
  findings: Finding[];
  fileCount: number;
  totalBytes: number;
};

// Each pattern describes something the text would make an agent DO, not
// vocabulary that merely sounds alarming. A security skill that discusses
// shells lands in needs_review, and that is the intended outcome: the cost is
// one human glance.
const TEXT_RULES: ReadonlyArray<readonly [string, RegExp, string]> = [
  ['instruction_override',
    /\b(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|messages?)/i,
    'tells an agent to discard the instructions it was given'],
  ['prompt_extraction',
    /\b(reveal|print|output|repeat|show)\b[^.\n]{0,40}\b(system prompt|your instructions)\b/i,
    'asks an agent to disclose its system prompt'],
  ['concealment',
    /\b(do not|don'?t|never)\b[^.\n]{0,30}\b(tell|inform|mention to|show)\b[^.\n]{0,20}\b(the )?(user|owner|human)\b/i,
    'asks an agent to hide what it is doing from its owner'],
  ['shell_execution',
    /(curl|wget|iwr|invoke-webrequest)[^\n|]{0,120}\|\s*(ba|z|sh|pwsh|iex|invoke-expression)/i,
    'pipes a download straight into a shell'],
  ['dynamic_execution',
    /\b(invoke-expression|os\.system|subprocess\.(run|call|popen)|child_process|eval\s*\(|exec\s*\()/i,
    'executes code it builds at run time'],
  // Reaching for a private key or a cloud secret is never ordinary.
  ['credential_access',
    /(~[/\\]\.ssh|id_rsa|id_ed25519|AWS_SECRET|AWS_SESSION_TOKEN)/i,
    'reaches for a private key or cloud secret'],
  // Naming a configuration variable is a different act, and conflating the two
  // is what put forty holds on the Mayor's desk over skills whose only sin was
  // a line telling the reader which key to set. The connector's scanner was
  // corrected first; this is the matching half, and the two must agree because
  // "Earth Verified" means both scans reached the same verdict on the same
  // bytes.
  ['needs_api_key',
    /(\.env\b|ANTHROPIC_API_KEY|OPENAI_API_KEY|\b\w*_API_KEY\b|\bprocess\.env\b|\bos\.environ\b)/i,
    'needs an API key or environment variable to be set'],
  // Order-independent: all three signals must share one line, so prose that
  // merely mentions a URL or the word "secret" stays clean.
  ['exfiltration',
    /^(?=[^\n]*\bhttps?:\/\/)(?=[^\n]*\b(?:post|send|upload|exfiltrat\w*|curl|fetch|transmit)\b)(?=[^\n]*\b(?:key|keys|token|secret|credential|password|\.env|history|contents?)\b)[^\n]*$/im,
    'sends local material to an outside address'],
  ['environment_mutation',
    /"?(mcpServers|hooks|allowedTools|permissions)"?\s*:\s*[{[]/i,
    'reconfigures the coding agent itself'],
  ['encoded_payload',
    /[A-Za-z0-9+/]{240,}={0,2}/,
    'carries a long encoded blob that a reader cannot inspect'],
  ['hidden_text',
    /[​‌‍⁠﻿]/,
    'contains invisible characters that hide text from a human reader'],
  // New in version 2. Direction-override controls can make rendered text read
  // differently from the bytes an agent consumes - the trojan-source shape.
  ['bidi_override',
    /[‪-‮⁦-⁩]/,
    'contains Unicode direction controls that make displayed text lie about its order'],
  // New in version 2. A listing's own prose has no business steering how an
  // agent uses OTHER tools; that is the tool-shadowing attack on MCP hosts.
  ['tool_shadowing',
    /\b(instead of (?:using|calling)|do not (?:use|call) the|before (?:using|calling) any other tool|always (?:use|call) this tool (?:first|instead)|intercept(?:s)? (?:all|other) tool|override the behavior of)\b/i,
    'instructs an agent to prefer, avoid, or intercept other tools'],
];

/**
 * Rules that describe what CODE does. In prose they are documentation, not
 * behaviour - a SKILL.md line reading "set OPENAI_API_KEY in your .env" tells a
 * human how to configure the thing. Only the config-naming rule softens; an
 * instruction to open a private key is an instruction wherever it is written.
 */
const BEHAVIOURAL_RULES = new Set(['needs_api_key']);
const PROSE_SUFFIXES = new Set(['.md', '.markdown', '.txt', '.rst']);

/** Does this file's name mean its contents are prose rather than code? */
export function isProseFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && PROSE_SUFFIXES.has(name.slice(dot).toLowerCase());
}

export function scanText(where: string, text: string, prose = false): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, pattern, detail] of TEXT_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    const severity = prose && BEHAVIOURAL_RULES.has(rule) ? 'capability' as const : 'review' as const;
    findings.push({ rule, severity, where, detail, line });
  }
  return findings;
}

/** Why an archive member name must never be extracted, or null when it is fine. */
export function unsafeMember(name: string): string | null {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return 'uses an absolute path, which would write outside the install folder';
  }
  if (normalized.split('/').some((part) => part === '..')) {
    return "walks up out of the install folder with '..'";
  }
  return null;
}

export type ScanEntry = {
  name: string;
  size: number;
  // ustar typeflag: '2' is a symlink, '5' a directory, '0'/'' a file.
  typeflag?: string;
  text?: string;
};

const suffixOf = (name: string) => {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
};

/**
 * One reproducible verdict over an unpacked listing, mirroring the
 * connector's scan_package member for member.
 */
export function scanEntries(entries: ScanEntry[]): ScanVerdict {
  const findings: Finding[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.typeflag === '5') continue;                       // directories
    const escape = unsafeMember(entry.name);
    if (escape) {
      findings.push({ rule: 'path_traversal', severity: 'refuse', where: entry.name, detail: escape, line: 0 });
      continue;
    }
    if (entry.typeflag === '2') {
      findings.push({
        rule: 'symlink', severity: 'refuse', where: entry.name,
        detail: 'is a symbolic link, which can escape the install folder', line: 0,
      });
      continue;
    }
    fileCount += 1;
    totalBytes += entry.size;

    const base = (entry.name.split('/').pop() ?? entry.name).toLowerCase();
    const suffix = suffixOf(entry.name);
    if (CONFIG_NAMES.has(base)) {
      findings.push({
        rule: 'environment_mutation', severity: 'review', where: entry.name,
        detail: 'is a coding-agent configuration file, not knowledge', line: 0,
      });
    }
    if (EXECUTABLE_SUFFIXES.has(suffix)) {
      findings.push({
        rule: 'executable_file', severity: 'review', where: entry.name,
        detail: `is a ${suffix} program, so installing it puts runnable code on the machine`, line: 0,
      });
    } else if (!INERT_SUFFIXES.has(suffix)) {
      findings.push({
        rule: 'unknown_file_type', severity: 'review', where: entry.name,
        detail: `has the unrecognised extension ${suffix || '(none)'} and cannot be read as knowledge`, line: 0,
      });
    }
    if (typeof entry.text === 'string' && (INERT_SUFFIXES.has(suffix) || TEXT_SCAN_SUFFIXES.has(suffix))) {
      findings.push(...scanText(entry.name, entry.text, isProseFile(entry.name)));
    }
  }

  if (fileCount === 0) {
    findings.push({ rule: 'empty_package', severity: 'refuse', where: 'package', detail: 'contains no files at all', line: 0 });
  }
  if (fileCount > MAX_FILES) {
    findings.push({
      rule: 'too_many_files', severity: 'refuse', where: 'package',
      detail: `holds ${fileCount} files, above the ${MAX_FILES} limit`, line: 0,
    });
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    findings.push({
      rule: 'too_large', severity: 'refuse', where: 'package',
      detail: `is ${totalBytes} bytes, above the ${MAX_TOTAL_BYTES} limit`, line: 0,
    });
  }
  if (!entries.some((entry) => ['.md', '.markdown'].includes(suffixOf(entry.name)) && entry.typeflag !== '5')) {
    findings.push({
      rule: 'no_documentation', severity: 'review', where: 'package',
      detail: 'ships no markdown, so there is nothing describing what it does', line: 0,
    });
  }

  // A capability describes the deposit; it never holds it back.
  const verdict = findings.some((finding) => finding.severity === 'refuse')
    ? 'refused' as const
    : findings.some((finding) => finding.severity === 'review')
      ? 'needs_review' as const : 'inert_safe' as const;
  const flags: string[] = [];
  for (const finding of findings) {
    if (finding.severity === 'capability') continue;
    if (!flags.includes(finding.rule)) flags.push(finding.rule);
  }
  return { verdict, flags, findings, fileCount, totalBytes };
}

/**
 * The exact bytes an "Earth Verified" signature covers. Newline-joined fixed
 * fields rather than JSON, so there is no canonicalisation to argue about:
 * two implementations either produce these bytes or they do not.
 */
export function verificationMessage(input: {
  digest: string; verdict: string; scannerVersion: string; signedAt: number;
}): string {
  return `earth-verified-v1\n${input.digest}\n${input.verdict}\n${input.scannerVersion}\n${input.signedAt}`;
}
