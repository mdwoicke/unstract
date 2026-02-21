/**
 * PII detection, tokenization, and rehydration.
 * Used before sending data to cloud LLM APIs to protect user privacy.
 */

export interface MaskResult {
  masked: Record<string, string>
  tokenMap: Record<string, string>
}

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'EMAIL',   pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { name: 'PHONE',   pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { name: 'SSN',     pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'CARD',    pattern: /\b(?:\d[ -]?){13,16}\b/g },
  { name: 'DOB',     pattern: /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g },
  { name: 'IC',      pattern: /\b[A-Z]\d{7}[A-Z]\b/g },  // Malaysian IC / passport-style
]

export function maskPayload(payload: Record<string, string | number | boolean | null>): MaskResult {
  const masked: Record<string, string> = {}
  const tokenMap: Record<string, string> = {}
  let counter = 0

  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) {
      masked[key] = String(value)
      continue
    }

    let strValue = String(value)
    for (const { name, pattern } of PII_PATTERNS) {
      strValue = strValue.replace(pattern, (match) => {
        const token = `{PII_${name}_${counter++}}`
        tokenMap[token] = match
        return token
      })
    }
    masked[key] = strValue
  }

  return { masked, tokenMap }
}

export function rehydrate(
  text: string,
  tokenMap: Record<string, string>
): string {
  let result = text
  for (const [token, original] of Object.entries(tokenMap)) {
    result = result.replaceAll(token, original)
  }
  return result
}
