# Portable build helpers

`make_portable.ps1` bundles an embeddable Python into `runtime\python` of the portable studio.

The embeddable Python is isolated by its `python314._pth` file (it never picks up another Python's
standard library from the registry), but that also makes it ignore `PYTHONPATH` and not add the
script's folder to `sys.path`. The studio relies on both (imports between project files, packages
installed with the Packages button), so `scriptcraft_paths.pth` is copied into `Lib\site-packages`:
`.pth` lines starting with `import` run at startup and add the script folder and `PYTHONPATH` back.

It also drops the user site folder (`%APPDATA%\Python\Python3xx`) from `sys.path`, so packages of a
Python installed on the same PC never leak into the portable one.
