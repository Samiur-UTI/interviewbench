# Fix the bug

You've joined the API platform team. `ratelimiter/` is the in-process library every service
uses to rate-limit requests per API key. Read the code first; it's small.

**Incident report:** several customers on the 5-requests-burst plan were able to send
hundreds of requests in a single second. It only happens to customers who had been
quiet for a while (overnight, after a deploy, etc.).

Find the root cause and fix it. Keep the public API unchanged.

Write down what you found in `NOTES.md`.
