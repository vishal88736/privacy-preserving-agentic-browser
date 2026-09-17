/**
 * Structured Action Parser
 * Extracts, parses, and validates the structured JSON action from LLM response.
 * L3: Now extracts full model response fields (task_understanding, grounding,
 * page_understanding, current_state) so the agent controller can update state.
 */

import { validateAction } from '../shared/schemas.js';

export class ActionParser {
  /**
   * Parses raw string response from LLM into a validated Action object
   * L3: Returns the complete structured response, not just action/thought
   */
  parse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      throw new Error('ActionParser received empty or invalid response string');
    }

    let cleaned = rawText.trim();
    // Strip markdown code fences if present (```json ... ```)
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/g, '').trim();

    // Sometimes LLMs prepend thoughts or text before the JSON object
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(`Failed to parse JSON action from LLM: ${err.message}. Raw output snippet: ${rawText.slice(0, 150)}`);
    }

    const action = (parsed.action && typeof parsed.action === 'object') ? parsed.action : parsed;
    const thought = parsed.thought || 'Executing next step';
    const isTerminal = parsed.is_terminal || (typeof action.action === 'string' && action.action === 'DONE');

    // Validate against strict action schema
    validateAction(action);

    // L3: Extract and return all structured model response fields
    return {
      thought,
      action,
      isTerminal,
      // Full response fields for progressive state updates
      task_understanding: parsed.task_understanding || null,
      grounding: parsed.grounding || null,
      page_understanding: parsed.page_understanding || null,
      current_state: parsed.current_state || null
    };
  }
}

export const defaultActionParser = new ActionParser();
