FROM golang:1.27.0-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY contracts ./contracts
COPY cmd ./cmd
COPY internal ./internal
COPY panel ./panel
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /dispatcher ./cmd/dispatcher

FROM build AS test
RUN apk add --no-cache gcc musl-dev
RUN go vet ./... && CGO_ENABLED=1 go test -race ./...

FROM alpine:3.23 AS runtime
RUN apk add --no-cache ca-certificates wget \
 && addgroup -g 10001 dispatcher \
 && adduser -D -u 10001 -G dispatcher dispatcher \
 && mkdir /data && chown dispatcher:dispatcher /data
COPY --from=build /dispatcher /usr/local/bin/dispatcher
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8090/readyz || exit 1
ENTRYPOINT ["dispatcher"]
CMD ["serve", "-db", "/data/dispatcher.db", "-listen", "0.0.0.0:8090"]
