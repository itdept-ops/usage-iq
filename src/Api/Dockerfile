# --- build ---
# NOTE: the build context is ./src (see docker-compose.yml) so the shared Ccusage.Ingestion
# project the API references is available alongside Api/.
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# Restore against just the project files first so the layer caches across source-only changes.
COPY Ingestion/Ccusage.Ingestion.csproj Ingestion/
COPY Api/Ccusage.Api.csproj Api/
RUN dotnet restore Api/Ccusage.Api.csproj

# Then the sources.
COPY Ingestion/ Ingestion/
COPY Api/ Api/
RUN dotnet publish Api/Ccusage.Api.csproj -c Release -o /app --no-restore

# --- runtime ---
FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
# curl is only here so the container HEALTHCHECK (and compose's service_healthy gate) can probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app ./
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://localhost:8080/api/health || exit 1
ENTRYPOINT ["dotnet", "Ccusage.Api.dll"]
