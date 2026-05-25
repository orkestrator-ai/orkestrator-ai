# Code Review

Review the code for quality, correctness, and maintainability.

## Evaluation Criteria

### DRY (Don't Repeat Yourself)
- Duplicated logic across files or functions
- Copy-pasted code that should be abstracted
- Similar patterns that could be unified
- Repeated magic values that should be constants

### Coupling & Cohesion
- Tight coupling between modules that should be independent
- God classes/functions doing too many things
- Scattered responsibilities across unrelated files
- Circular dependencies

### Abstraction Quality
- Leaky abstractions exposing implementation details
- Over-engineering or premature abstraction
- Missing abstractions where patterns repeat 3+ times
- Wrong level of abstraction (too high or too low)

### Error Handling
- Missing error handling for failure cases
- Swallowed exceptions hiding problems
- Inconsistent error handling patterns
- Missing validation at system boundaries

### Correctness
- Logic errors and off-by-one mistakes
- Mutable default arguments (Python)
- Race conditions or state management issues
- Edge cases not handled

### Naming & Organization
- Misleading or unclear names
- Poor file/folder organization
- Inconsistent naming conventions
- Names that don't reflect purpose

### Security
- SQL injection, XSS, CSRF vulnerabilities
- Authentication/authorization bypasses
- Sensitive data exposure (hardcoded secrets, logging credentials)
- Insecure deserialization or input handling
- Missing input validation at trust boundaries

### Project Guidelines
- Check for CLAUDE.md at repository root and relevant subdirectories
- Verify adherence to explicit project rules for imports, style, conventions
- Only flag style issues explicitly called out in project guidelines
- If code follows documented project conventions, don't flag it as an issue

## Severity Levels

- **P0**: Broken functionality, crashes, data corruption, security vulnerabilities
- **P1**: Bugs that will cause problems in practice, significant maintainability issues
- **P2**: Code quality improvements, minor issues, polish

## Confidence Scoring

For each issue, assess confidence (0-100):
- **0-25**: Might be intentional or context-dependent
- **50**: Real issue but minor impact
- **75**: Verified issue that will cause problems
- **100**: Definite bug with clear evidence

**Only report issues with confidence >= 75.**

## What to Skip

- Style/formatting issues (handled by linters)
- Issues that linters, type checkers, or compilers will catch
- Minor naming preferences without clear improvement
- Suggestions requiring major architectural changes
- Issues in generated or vendored code
- Performance micro-optimizations without measured impact
- Issues explicitly silenced with lint/ignore comments
- Style disagreements not covered by project guidelines

## Output Format

Return structured JSON with:
- `strengths`: Array of things done well (specific, with file:line references)
- `issues`: Array of findings with severity, category, description, file, line, suggestion, symbol, and optionally fixes
- `recommendations`: Array of general improvements (not tied to specific issues)
- `verdict`: Object with `ready` ("yes", "no", "with-fixes") and `reasoning` (1-2 sentences)
- `summary`: Brief count (e.g., "3 issues found: 1 P1, 2 P2")

### Strengths Field

Acknowledge what's done well. Be specific with file:line references:
- "Clean separation of concerns in auth module (auth.py:15-80)"
- "Comprehensive error handling with proper fallbacks (api.py:45-60)"

### Description Field

Provide 1-3 sentences as needed. Simple issues need one sentence; non-trivial issues deserve more context.

### Symbol Field

**Always identify the symbol** (function, method, or class name) where the issue occurs:
- For issues inside functions: use the function name (e.g., `filter_transactions`)
- For issues inside methods: use `ClassName.method_name` (e.g., `Analyzer.process`)
- For class-level issues: use the class name (e.g., `TransactionParser`)
- For module-level issues: use empty string `""`

This enables IDE navigation (go-to-definition) from the review results.

### Fixes Field (Optional)

For issues with multiple valid fix strategies, include 1-3 approaches with trade-offs:
- **Use null** for obvious single-solution fixes (most issues)
- **Include array with 2-3 approaches** when there are meaningful alternatives with different trade-offs
- Each approach needs: brief name/description and trade-off explanation

Example with multiple fix strategies:
```json
"fixes": [
  {"approach": "Extract to helper function", "tradeoff": "Cleaner but adds indirection"},
  {"approach": "Inline the logic", "tradeoff": "More verbose but explicit"}
]
```

Example without (obvious fix):
```json
"fixes": null
```

### Verdict Field

Assess production readiness:
- `"yes"` - Ready to ship/merge as-is
- `"with-fixes"` - Ready after addressing P0/P1 issues
- `"no"` - Significant problems need resolution first

Reasoning should be 1-2 sentences explaining the assessment.

### Example Output

```json
{
  "strengths": [
    "Clean database schema with proper migrations (db.ts:15-42)",
    "Comprehensive test coverage for edge cases (tests/:*)"
  ],
  "issues": [
    {
      "severity": "P1",
      "category": "error-handling",
      "description": "Missing validation for date input. Invalid dates silently return no results.",
      "file": "search.ts",
      "line": 25,
      "suggestion": "Validate ISO format, throw error with example of valid format",
      "symbol": "searchByDate",
      "fixes": null
    }
  ],
  "recommendations": [
    "Add progress indicators for long-running operations",
    "Consider config file for excluded projects"
  ],
  "verdict": {
    "ready": "with-fixes",
    "reasoning": "Core implementation is solid. P1 issue is easily fixed and doesn't affect core functionality."
  },
  "summary": "1 issue found: 1 P1"
}
```

Focus on actionable findings. Quality over quantity.