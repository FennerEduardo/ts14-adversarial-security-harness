# 🚀 AI AGENT MASTER IMPLEMENTATION PROMPT
## Feature: Creación de Pedido con Token de Autenticación (Spec Hash: f4221a12)
## Architecture: MONOLITH | Stack: TYPESCRIPT (nestjs)
## Prompt Version / Audit Hash: prt_d505a4f4
## Author / Developer: Fenner Eduardo González C. <fennereduardo@gmail.com> (source: git)

### 📌 Context Files to Read & Follow:
- @.ghkgovernance.yaml
- @features/create_order.feature

### 🛠️ Technical Guardrails & Stack Specifications:
- **Language**: typescript (nestjs)
- **Persistence**: prisma + mysql
- **Validation**: zod
- **Testing Framework**: vitest

### 🐳 Docker Execution Sandbox & Host Isolation Guardrails:
> **IMPORTANT**: If your host operating system lacks the native runtime SDK (TYPESCRIPT), DO NOT install heavy packages directly on the host machine.
> Execute all compilation, migrations, and test runs inside the isolated Docker container:
> 
> ```bash
> # Start database and infrastructure services
> docker compose up -d
> 
> # Execute test suite inside Docker sandbox container:
> docker compose run --rm app npx vitest run
> ```

### 🎯 Mandatory Step-by-Step Implementation Flow:

#### Phase 1: Pure Domain Layer
1. Read the feature specification in `features/create_order.feature` and contract in `contracts.ts`.
2. Implement pure domain Entities, Value Objects, and Domain Events.
3. Ensure zero dependencies on external frameworks or database drivers in the domain core.

#### Phase 2: Application Use Cases & Infrastructure
1. Implement the Repository Port interface using PRISMA (mysql).
2. Implement Controllers/Handlers to process HTTP requests and return appropriate status codes (e.g. 201 Created, 400 Bad Request).
3. Apply validation using zod.

#### Phase 3: Automated Unit & Feature Testing
1. Implement automated test cases in VITEST matching all scenarios in `features/create_order.feature`.
2. Assert HTTP response status codes, payload structures, and event emissions.
3. If host environment lacks SDK, run verification inside Docker sandbox (`docker compose run --rm app npx vitest run`).
4. Ensure 100% scenario pass rate.
