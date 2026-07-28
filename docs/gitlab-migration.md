# LittleLives GitLab migration

The canonical repository is moving to:

`https://git.littlelives.io/Front-End/jittle-lamp`

## Migration state

- Source branches and release tags have been copied from GitHub.
- GitHub remains the fallback remote while production and public releases still depend on it.
- GitLab CI verifies the full Bun workspace.
- Commits on `main` and stable version tags validate the production backend image.
- Backend deployment, production data, DNS, and public desktop releases have not been cut over.

## GitLab CI

Merge requests run:

1. frozen dependency installation
2. version synchronization check
3. backend lint, typecheck, and tests
4. workspace typecheck, tests, and build

After merge, GitLab builds the production Dockerfile into a temporary OCI image
and verifies that the output is non-empty. Publication is deliberately disabled:
the shared Kubernetes runner cannot reach the GitLab Container Registry endpoint
on port `5050`, and the LittleLives ECR repository has not yet been provisioned.

## Deployment prerequisites

Before adding a production deployment job, LittleLives DevOps must confirm:

- target Kubernetes cluster or container runtime
- target namespace and service name
- GitLab Container Registry versus LittleLives ECR
- ingress hostname, recommended as `api.jittlelamp.dev`
- deployment strategy and rollback command
- database migration job ownership
- monitoring, alerting, and log destination

The current LittleLives convention is AWS ECR. Once DevOps creates the
`jittle-lamp` repository and grants the runner access, replace the temporary OCI
output with the standard ECR BuildKit push and add the Argo CD deployment job.

The application containers must set `RUN_DB_MIGRATIONS=false`. Database migrations
should be executed once by a dedicated deployment job before the new application
version receives traffic.

## Production variables

Do not copy local `.env` files into Git. Add replacement credentials under
LittleLives-owned accounts as protected, environment-scoped GitLab variables:

- `APP_SECRET`
- `DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ENDPOINT` when required
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_AUTHORIZED_PARTIES`
- `WEB_APP_ORIGIN`
- `JITTLE_LAMP_API_ORIGIN`

Rotate credentials during cutover instead of reusing credentials owned by the
previous personal accounts.

## Transition constraints

- The frontend remains hosted by Vercel.
- Existing desktop and extension releases contain `jl-api.monthlyparty.com`.
- The desktop updater and installer still consume public GitHub Releases.
- Keep the old API hostname and GitHub release delivery available until compatible
  clients have been published and adopted.
- Transfer the domain registrar only after the backend and data migration are stable.
