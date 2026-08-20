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
6. Initialize, then iterate in the same journal or a follow-up journal the user asked for.

Prefer documented TUI. If a zone name is missing, inspect the mesh or case instead of guessing.
