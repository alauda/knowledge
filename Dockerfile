FROM registry.alauda.cn:60080/ops/alpine:3

RUN mkdir -p /dist/

COPY dist/ /dist/
