# DevOps tasks

Container, CI, infrastructure-as-code and deploy-script tasks. They must never need real
cloud accounts. Create one with `ib new <task-id> --category devops --template <template>`;
see docs/TASK_FORMAT.md. There are no devops tasks or templates yet: use
`--template backend-python` and replace the stack, or add one under `templates/`.
