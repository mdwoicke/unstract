/**
 * Multi-signal field resolution for re-applying templates.
 *
 * When a template is applied to a page, the original CSS selectors may no
 * longer work (dynamic IDs, page re-renders). This module scores all
 * (mapping, currentField) pairs using multiple signals and performs greedy
 * one-to-one assignment.
 */

import type { FieldDescriptor } from '../store/state'
import type { TemplateFieldMapping } from '../store/template'

// ─── Signal weights ─────────────────────────────────────────────────────────────

const WEIGHT_ID    = 0.50  // HTML IDs are unique, strongest signal
const WEIGHT_NAME  = 0.30  // Form names are stable (backend-facing)
const WEIGHT_LABEL = 0.15  // Catches rephrased labels
const WEIGHT_TYPE  = 0.05  // Confirms other signals

const MIN_THRESHOLD = 0.25

// ─── Scoring ────────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
}

function tokenOverlap(a: string, b: string): number {
  if (!a || !b) return 0
  const tokA = tokenize(a)
  const tokB = tokenize(b)
  if (tokA.length === 0 || tokB.length === 0) return 0
  const setB = new Set(tokB)
  const overlap = tokA.filter(t => setB.has(t)).length
  return overlap / Math.max(tokA.length, tokB.length)
}

function scoreMapping(mapping: TemplateFieldMapping, field: FieldDescriptor): number {
  let score = 0

  // ID match (exact, case-insensitive)
  if (mapping.fieldId && field.id && mapping.fieldId.toLowerCase() === field.id.toLowerCase()) {
    score += WEIGHT_ID
  }

  // Name match (exact, case-insensitive)
  if (mapping.fieldName && field.name && mapping.fieldName.toLowerCase() === field.name.toLowerCase()) {
    score += WEIGHT_NAME
  }

  // Label token overlap
  score += WEIGHT_LABEL * tokenOverlap(mapping.fieldLabel, field.label)

  // Type match
  if (mapping.fieldType && field.type && mapping.fieldType.toLowerCase() === field.type.toLowerCase()) {
    score += WEIGHT_TYPE
  }

  return score
}

// ─── Resolution ─────────────────────────────────────────────────────────────────

export interface ResolvedMapping {
  mapping: TemplateFieldMapping
  field: FieldDescriptor
  score: number
}

/**
 * Resolve all template mappings against the current page fields.
 * Returns matched pairs sorted by score (highest first).
 * Uses greedy one-to-one assignment: no field or mapping used twice.
 */
export function resolveAllMappings(
  mappings: TemplateFieldMapping[],
  currentFields: FieldDescriptor[]
): ResolvedMapping[] {
  // Score all (mapping, field) pairs
  const candidates: Array<{ mi: number; fi: number; score: number }> = []

  for (let mi = 0; mi < mappings.length; mi++) {
    for (let fi = 0; fi < currentFields.length; fi++) {
      const score = scoreMapping(mappings[mi], currentFields[fi])
      if (score >= MIN_THRESHOLD) {
        candidates.push({ mi, fi, score })
      }
    }
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score)

  // Greedy one-to-one assignment
  const usedMappings = new Set<number>()
  const usedFields = new Set<number>()
  const results: ResolvedMapping[] = []

  for (const c of candidates) {
    if (usedMappings.has(c.mi) || usedFields.has(c.fi)) continue
    usedMappings.add(c.mi)
    usedFields.add(c.fi)
    results.push({
      mapping: mappings[c.mi],
      field: currentFields[c.fi],
      score: c.score,
    })
  }

  return results
}
