---
name: fluent-setup
description: Set up an ANSYS Fluent case from mesh to solver controls in a batch journal. Use when importing a mesh, choosing models, assigning materials and boundary conditions, or preparing a first solve.
---

# Set up a Fluent case

Work from the files in the workspace. Probe Fluent first when the installation is unknown.

## Order

1. Read the mesh or existing case.
2. Check scale, units, and zone names before assigning models.
3. Enable only the models the physics requires.
4. Assign materials and boundary conditions by zone name from the mesh, not invented labels.
5. Set solution methods, controls, and monitors.
6. Initialize, then iterate. Put a long iterate/solve in a journal run with `run_in_background: true`.

Prefer documented TUI. If a zone name is missing, inspect the mesh or case instead of guessing.

## First-setup journal

```
/file/set-batch-options
yes
yes
/file/read-mesh
"mesh.msh"
/mesh/check
/define/models/viscous/kw-sst
yes
/solve/initialize/initialize-flow
yes
/solve/iterate
50
/file/write-case-data
"setup.cas.h5"
/exit
yes
```

Keep model and BC lines in the same journal only when the zone names are known from the mesh. Otherwise stop after `/mesh/check`, read the output, then write a follow-up journal.
