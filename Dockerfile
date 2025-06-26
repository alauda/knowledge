FROM build-harbor.alauda.cn/ops/alpine:3

RUN mkdir -p /dist/

COPY dist/ /dist/
