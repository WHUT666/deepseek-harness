---
name: fluent-udf
description: Author ANSYS Fluent UDF C sources (.c) and the journal commands that compile or load them. Use when the user needs a user-defined function, boundary profile, source term, or compiled UDF library.
---

# Author Fluent UDFs

Write UDF C sources with file tools. Do not paste large UDF bodies into chat when a `.c` file in the workspace will do.

## Source rules

- Include `udf.h` and use the documented `DEFINE_*` macros.
- Keep one concern per file when possible (one profile, one source term).
- Match thread and domain assumptions to the journal that loads the library.
- Prefer interpreted UDFs only for small, single-file experiments; compiled libraries belong in a journal compile/load sequence.

## Compile and load (TUI)

The journal, not the `fluent` tool, compiles and loads the UDF. After editing the `.c` file, update the journal and rerun `runJournal`.

```
/define/user-defined/compiled-functions
compile
libudf
yes
yes
""
"udf.c"
""
/define/user-defined/compiled-functions
load
libudf
```

Replace `udf.c` and `libudf` with the workspace source and library names. Do not treat this as a UDF tutorial; keep the C source in the file tools.
