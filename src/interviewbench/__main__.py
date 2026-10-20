"""`python -m interviewbench ...` works like `ib ...`, even when `ib` isn't on PATH."""

from .cli import app

app(prog_name="ib")
