# AI Factory Org Structure (Kyndryl)

Snapshot of the Kyndryl company's agent org chart, restructured for the
software development life cycle (SDLC). Reporting lines mirror the live
`agents` table (`reports_to`); this file is a reference snapshot, not a seed
— the app has no org-template loader, so edits here don't apply themselves.

```
CEO
├─ CTO (Chief Technology Officer)
│  ├─ Backend Lead (Backend Engineering Lead)
│  │  ├─ Backend Engineer 1
│  │  ├─ Backend Engineer 2
│  │  └─ Backend Engineer 3
│  ├─ Frontend Lead (Frontend Engineering Lead)
│  │  ├─ Frontend Engineer 1
│  │  └─ Frontend Engineer 2
│  ├─ QA Lead
│  │  └─ QA Engineer
│  ├─ Security Engineer
│  ├─ DevOps Lead (DevOps / Platform Lead)
│  │  └─ Site Reliability Engineer
│  ├─ Release Manager (Release / Deploy)
│  └─ Code Reviewer (Code Review / Security)
├─ Head of Product
│  ├─ Product Manager
│  └─ Technical Writer
├─ Research Lead
│  └─ Researcher
└─ Head of Design
   └─ UX Designer
```

23 agents total. Restructured 2026-07-01: removed 10 agents left over from
the deleted Agents Studio/Integrators feature (AI Factory Director, IT
Operations Lead, Integrations Engineer, HR Onboarding Agent, HR Operations
Lead, Finance Operations Lead, Procurement Lead, a duplicate QA Engineer, and
a redundant generalist Software Engineer), and reparented Release Manager and
Code Reviewer under CTO. `AGENTS.md` for those two was rewritten to reflect
their place in the engineering chain instead of the removed factory-director
mandate.
