FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS deno
FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
COPY --from=deno /deno /usr/local/bin/deno
WORKDIR /app
COPY app.py /app/app.py
COPY vendor /app/vendor
RUN python -c "import app; app.load_scripts('/app/vendor'); app.DenoRunner(app.load_scripts('/app/vendor')).verify_version()"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000:1000
EXPOSE 7860
CMD ["python", "/app/app.py"]
