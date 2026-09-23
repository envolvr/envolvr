# dstack simulator 0.5.3 (Linux x86_64) with its socket bridged to TCP 8090.
# Unpack dstack-simulator-0.5.3-x86_64-linux-gnu.tgz from the Dstack-TEE/dstack
# v0.5.3 release next to this file, then:
#   docker build -t envolvr/dstack-sim:0.5.3 . && docker run -d -p 127.0.0.1:8090:8090 envolvr/dstack-sim:0.5.3

FROM ubuntu:24.04
RUN apt-get update -qq && apt-get install -y --no-install-recommends socat ca-certificates && rm -rf /var/lib/apt/lists/*
COPY dstack-simulator-0.5.3-x86_64-linux-gnu/ /sim/
WORKDIR /sim
EXPOSE 8090
CMD ["sh", "-c", "./dstack-simulator & sleep 2; exec socat TCP-LISTEN:8090,fork,reuseaddr UNIX-CONNECT:/sim/dstack.sock"]
