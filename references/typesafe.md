# TypeSafe System One — contract and design notes

Distilled from docs.typesafe.ai so a triage run does not need to re-read the site.
The live docs remain authoritative; re-check them if something here does not match
what the API returns.

## Endpoint

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

Request: `{ "model": "jev-latest", "state": <string|object|array>, "questions": { "<id>": <Question> } }`

Question ids are for your code — they are **not** sent to the model. The question
has to carry its full meaning in `instructions`, because naming a question
`severity` communicates nothing to Jev.

## The criteria-shape gotcha

This is the single easiest thing to get wrong:

| Type | `criteria` shape | Returns |
| --- | --- | --- |
| `choice` | **object** — option name → description | `choice`, `probabilities`, `confidence` |
| `noul` | **object** — `true` / `false` descriptions | `noul` (probability of yes) |
| `score` | **ordered array** — index *is* the level | `score`, `legend`, `probabilities`, `confidence` |

Passing an array to a Choice, or an object to a Score, is a 4xx.

## Reading a Score

`score` is a probability-weighted mean of level **indices**, not a percentage.
Four levels means the range is 0–3, so normalize with `score / (levels - 1)`.

```json
{ "type": "score", "score": 1.43, "confidence": 0.35,
  "probabilities": { "0": 0.0, "1": 0.57, "2": 0.43 } }
```

Each level is evaluated independently — the model never sees a level's number or
its neighbours. Two levels that describe overlapping situations therefore split
the distribution and depress confidence. Write levels that stand alone.

## Choosing a primitive

- **Choice** — exactly one of a defined set. The distribution compares the options.
- **Noul** — does this condition hold. Returns probability of yes; there is no
  separate confidence, and 0.5 means genuinely undecided, not "medium intensity".
  Use one Noul per label when several labels can apply at once.
- **Score** — position on an ordered spectrum with described levels.

## Confidence

Derived from the concentration of the probability distribution. Concentrated is
confident; spread out is uncertain.

Confidence is **not** accuracy. It reports internal consistency, so a confidently
wrong answer is unremarkable. The documented tiers: below 0.5 wants human review,
0.5–0.9 proceed with care, above 0.9 is safe to automate *where the action is low
stakes*. Applying labels is low stakes; merging issues is not.

Several genuinely acceptable answers also spread probability, so low confidence
on a harmless choice is not automatically a problem.

## Batching

Independent questions over the same state belong in one request: the state is
billed once and the questions are answered in parallel. The docs report roughly
an order of magnitude on both cost and latency versus one request per question.

Speculative questions are fine and often cheaper than a second round trip — state
the premise inside the question wording ("If this describes a defect, …") since
the model cannot see which branch your code will take.

## Design principles that carry over

- Keep control flow, arithmetic, dates, and side effects in code.
- Decompose. Four scored dimensions you can re-weigh beat one opaque verdict.
- Put facts in `state`, judgments in `questions`.
- Typed output guarantees the shape of the answer, never its truth. Validate
  against your own data before trusting thresholds.

## Known rough edges

See `https://docs.typesafe.ai/model-jaggedness/jev-1.13.md` for the current
model's documented failure modes before concluding a bad answer is your rubric's
fault.
