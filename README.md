# interviewbench

Realistic AI-era coding interview tasks with rubrics, a grader that scores your solution,
and a leaderboard of how LLMs do on the same tasks.

> Work in progress — v0.1 launching soon.

## Quickstart

```bash
git clone <repo-url> && cd interviewbench
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .

ib list
ib start rate-limiter          # copies the starter repo to ib-workspace/rate-limiter
ib prompt rate-limiter -s 1    # shows the stage 1 brief
# ...solve it with any AI assistant you like...
ib grade --dir ib-workspace/rate-limiter
```

## How a task works

Each task mirrors the new AI-enabled interview format: a small multi-file codebase and three stages.

1. **Fix the bug** — diagnose a realistic defect.
2. **Add a feature** — extend the code cleanly.
3. **Optimize** — make it scale.

Hidden tests check each stage; a weighted rubric scores the result.

## License

MIT
