FROM golang:1.27.0-alpine AS dispatcher
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY contracts ./contracts
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o /dispatcher ./cmd/dispatcher

FROM node:22-bookworm-slim AS test
WORKDIR /src/processor
COPY processor/package.json processor/package-lock.json ./
RUN npm ci
COPY processor ./
COPY contracts /src/contracts
COPY --from=dispatcher /dispatcher /dispatcher
ENV E2E_DISPATCHER=/dispatcher
RUN npm test
