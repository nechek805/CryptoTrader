# ADR 0041: Durable paper study sessions

2026-11-03 · Module 15 Iteration 2 · Accepted

The study coordinator binds reviewed read-only acquisition ports to the frozen protocol
and existing durable paper broker. Every path, including queued candidates, passes the
manifest/model/calendar/origin gate and current receipt clock. Admitted news/fusion
entries additionally resolve an immutable native event snapshot with enough independent
origins known by the decision. Missing/late inputs cannot become retrospective entries.
No trading transport or private exchange keys are introduced.

The CLI schedules UTC start/end and consumes bounded, hash-named immutable inbox files
from separately operated acquisition/producer workers. Heartbeats are source observations;
supervisor ticks do not pretend a news poll succeeded. All emitted candidates (including
HOLD/veto), costs, fills, controls, outages and corrections are retained. Missing scheduled
arm outcomes are explicit failures, never silently filled with fabricated decisions.
Daily/weekly QA and coverage are reconstructible from the raw ledger/annotation history.
Restart retains the same manifest and verified prefix, with an explicit incident segment.

The accelerated fixture spans thirty virtual UTC days and a deliberately sparse frozen
opportunity set. It exercises multi-hour news/market outages, duplicate input, delayed
confirmation/correction, adverse gaps, pause/resume and prefix restart. Sparse trading
must remain inconclusive. This does not claim an elapsed thirty-day public forward study.
Native broker/report work budgets still apply; capacity exhaustion stops/flags the study.
