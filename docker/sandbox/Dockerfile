# syntax=docker/dockerfile:1

# TrueForge's current release-owned sandbox tag
# (0dab475d3d20a8333cff41f25f88e7134c424cf9), locked to the exact image digest
# resolved by the registry so this derivative remains reproducible.
ARG TRUEFORGE_SANDBOX_IMAGE=tfy.jfrog.io/tfy-images/trueforge-sandbox@sha256:63196eb7c45b75b24e1354d1343eae38698a60fc9f638ee47e8d05c838bbae09
FROM ${TRUEFORGE_SANDBOX_IMAGE}

USER root
COPY packages/artifacts/python/forty_two_artifacts.py /usr/local/lib/python3.13/site-packages/forty_two_artifacts.py

RUN python -c 'import hashlib, pathlib, pandas, forty_two_artifacts; source = pathlib.Path(forty_two_artifacts.__file__).resolve(); frame = pandas.DataFrame({"n": [1, 2]}); assert source == pathlib.Path("/usr/local/lib/python3.13/site-packages/forty_two_artifacts.py"); assert callable(forty_two_artifacts.emit_table) and callable(forty_two_artifacts.load_table); assert pandas.__version__ == "3.0.5" and int(frame["n"].sum()) == 3; print(hashlib.sha256(source.read_bytes()).hexdigest())'

LABEL org.opencontainers.image.title="Forty Two TrueForge sandbox"
LABEL org.opencontainers.image.description="Pinned TrueForge sandbox with the platform artifact helper baked into Python site-packages"
