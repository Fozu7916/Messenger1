# --- 1. сборка фронтенда ---
FROM node:20 AS front
WORKDIR /f
COPY Frontend/package*.json ./
RUN npm ci
COPY Frontend/ .
RUN npm run build

# --- 2. сборка бэкенда + вставка фронта в wwwroot ---
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY backend/ ./backend/
RUN dotnet publish backend/src/Messenger.Api/Messenger.Api.csproj -c Release -o /app/publish
COPY --from=front /f/dist /app/publish/wwwroot

# --- 3. рантайм ---
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://0.0.0.0:10000
EXPOSE 10000
ENTRYPOINT ["dotnet", "Messenger.Api.dll"]