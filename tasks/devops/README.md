# DevOps tasks

Container, CI, infrastructure-as-code and deploy-script tasks. They must never need real
cloud accounts, clusters or credentials: hidden tests evaluate the files a pipeline would apply.
Create one with `ib new <task-id> --category devops --template <template>`; see
docs/TASK_FORMAT.md. There is no devops template yet: use `--template backend-python` and replace
the stack, or add one under `templates/`.

- `cluster-cutover`: a platform repo after a Compose-to-Kubernetes cutover (cloud firewall, kubeadm, RBAC, a Vault configuration tree, a Python payments service). The hidden tests simulate the firewall, the API server's and kubelet's authentication and RBAC, Vault's policies and kubernetes auth, and Vault Agent in a pod; they need only Python.
