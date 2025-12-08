#!/bin/bash

CMD_NAME="$0"

DEFAULT_INSTALLER_IP="127.0.0.1"
DEFAULT_DRY_RUN="false"
DEFAULT_WAIT="true"
DEFAULT_ADMIN_USERNAME="admin"
DEFAULT_CRI_VERSION="containerd://1.6.20-4"
DEFAULT_SELF_VIP="false"
DEFAULT_VRID="137"
DEFAULT_PLATFORM_HTTP="0"
DEFAULT_PLATFORM_HTTPS="443"
DEFAULT_CNI_TYPE="ovn"
DEFAULT_DUAL_STACK="false"
DEFAULT_CLUSTER_CIDR_IPV4="10.3.0.0/16"
DEFAULT_SERVICE_CIDR_IPV4="10.4.0.0/16"
DEFAULT_JOIN_CIDR_IPV4="100.64.0.0/16"
DEFAULT_CLUSTER_CIDR_IPV6="fd00:10:16::/64"
DEFAULT_SERVICE_CIDR_IPV6="fd00:10:96::/112"
DEFAULT_JOIN_CIDR_IPV6="fd00:100:64::/64"
DEFAULT_HOSTNAME_AS_NODE_NAME="false"
DEFAULT_NODE_ISOLATE="false"
DEFAULT_CONTROL_PLANES_APP_DEPLOYABLE="false"
DEFAULT_SSH_PORT="22"
DEFAULT_SSH_USERNAME="root"
DEFAULT_NODE_MAX_PODS="110"
DEFAULT_PRODUCTS="base,acp,devops,asm,dataServices"

INSTALLER_IP=${INSTALLER_IP:-"${DEFAULT_INSTALLER_IP}"}
INSTALLER_ENDPOINT=${INSTALLER_ENDPOINT:-""}
CONFIG_FILE=${CONFIG_FILE:-""}
USE_EXIST_CONFIG_FILE=${USE_EXIST_CONFIG_FILE:-"false"}
DRY_RUN=${DRY_RUN:-"${DEFAULT_DRY_RUN}"}
WAIT=${WAIT:-"${DEFAULT_WAIT}"}

ADMIN_USERNAME=${ADMIN_USERNAME:-"${DEFAULT_ADMIN_USERNAME}"}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-""}

CLUSTER_VERSION=${CLUSTER_VERSION:-""}
CRI_VERSION=${CRI_VERSION:-"${DEFAULT_CRI_VERSION}"}

SELF_VIP=${SELF_VIP:-"${DEFAULT_SELF_VIP}"}
VRID=${VRID:-"${DEFAULT_VRID}"}

CLUSTER_HA=${CLUSTER_HA:-""}
PLATFORM_DOMAIN=${PLATFORM_DOMAIN:-""}
PLATFORM_HTTP=${PLATFORM_HTTP:-"${DEFAULT_PLATFORM_HTTP}"}
PLATFORM_HTTPS=${PLATFORM_HTTPS:-"${DEFAULT_PLATFORM_HTTPS}"}
TLS_SELF_SIGNED=${TLS_SELF_SIGNED:-"false"}
TLS_CERT_FILE=${TLS_CERT_FILE:-""}
TLS_KEY_FILE=${TLS_KEY_FILE:-""}

EXTERNAL_REGISTRY_ADDRESS=${EXTERNAL_REGISTRY_ADDRESS:-""}
REGISTRY_DOMAIN=${REGISTRY_DOMAIN:-""}
REGISTRY_USERNAME=${REGISTRY_USERNAME:-""}
REGISTRY_PASSWORD=${REGISTRY_PASSWORD:-""}

CNI_TYPE=${CNI_TYPE:-"${DEFAULT_CNI_TYPE}"}
DUAL_STACK=${DUAL_STACK:-"${DEFAULT_DUAL_STACK}"}

CLUSTER_CIDR_IPV4=${CLUSTER_CIDR_IPV4:-"${DEFAULT_CLUSTER_CIDR_IPV4}"}
SERVICE_CIDR_IPV4=${SERVICE_CIDR_IPV4:-"${DEFAULT_SERVICE_CIDR_IPV4}"}
JOIN_CIDR_IPV4=${JOIN_CIDR_IPV4:-"${DEFAULT_JOIN_CIDR_IPV4}"}

CLUSTER_CIDR_IPV6=${CLUSTER_CIDR_IPV6:-"${DEFAULT_CLUSTER_CIDR_IPV6}"}
SERVICE_CIDR_IPV6=${SERVICE_CIDR_IPV6:-"${DEFAULT_SERVICE_CIDR_IPV6}"}
JOIN_CIDR_IPV6=${JOIN_CIDR_IPV6:-"${DEFAULT_JOIN_CIDR_IPV6}"}

NETWORK_DEVICE=${NETWORK_DEVICE:-""}

HOSTNAME_AS_NODE_NAME=${HOSTNAME_AS_NODE_NAME:-"${DEFAULT_HOSTNAME_AS_NODE_NAME}"}

NODE_ISOLATE=${NODE_ISOLATE:-"${DEFAULT_NODE_ISOLATE}"}
CONTROL_PLANES_APP_DEPLOYABLE=${CONTROL_PLANES_APP_DEPLOYABLE:-"${DEFAULT_CONTROL_PLANES_APP_DEPLOYABLE}"}

CONTROL_PLANES=${CONTROL_PLANES:-""}
CONTROL_PLANES_IPV6=${CONTROL_PLANES_IPV6:-""}

WORKERS=${WORKERS:-""}
WORKERS_IPV6=${WORKERS_IPV6:-""}

SSH_PORT=${SSH_PORT:-"${DEFAULT_SSH_PORT}"}
SSH_USERNAME=${SSH_USERNAME:-"${DEFAULT_SSH_USERNAME}"}
SSH_PASSWORD=${SSH_PASSWORD:-""}
SSH_KEY_FILE=${SSH_KEY_FILE:-""}

PROMETHEUS_NODES=${PROMETHEUS_NODES:-""}
ELASTICSEARCH_NODES=${ELASTICSEARCH_NODES:-""}
VICTORIAMETRICAS_NODES=${VICTORIAMETRICAS_NODES:-""}
VICTORIAMETRICAS_AGENT_REPLICAS=${VICTORIAMETRICAS_AGENT_REPLICAS:-"0"}

NODE_MAX_PODS=${NODE_MAX_PODS:-"${DEFAULT_NODE_MAX_PODS}"}

ALTERNATIVE_HOSTS=${ALTERNATIVE_HOSTS:-""}
PRODUCTS=${PRODUCTS:-"${DEFAULT_PRODUCTS}"}

function usage() {
    echo "Usage:
${CMD_NAME} <options>
options:
    --installer-ip                      IP address of the server running the installer package. Default: ${DEFAULT_INSTALLER_IP}
    --config-file                       Path to the configuration file. Indicates using an existing configuration file; all other arguments except --installer-ip, --dry-run, and --wait will be ignored.
    --dry-run                           Only generate and display the configuration file without actually starting the installation. Default: ${DEFAULT_DRY_RUN}
    --wait                              Wait for the deployment to complete. Default: ${DEFAULT_WAIT}

    --admin-username                    Administrator username. Default: ${DEFAULT_ADMIN_USERNAME}
    --admin-password                    Administrator password

    --cluster-version                   Kubernetes version. Optional; defaults to the built‑in platform default version.
    --cri-version                       CRI and its version. Default: ${DEFAULT_CRI_VERSION}
                                        You can obtain the available versions of Kubernetes and CRI as follows:
                                        curl -H \"Authorization: Bearer <TOKEN>\" \${INSTALLER_IP}:8080/api/v1/namespaces/kube-public/configmaps/base-component-version
                                        The <TOKEN> can be obtained via:
                                        curl \${INSTALLER_IP}:8080//cpaas-installer/api/token

    --self-vip                          Whether to enable a self‑managed VIP. Default: ${DEFAULT_SELF_VIP}
    --vrid                              VRID for the self‑managed VIP. Valid range: 1–255. VRID values must be unique within the same subnet. Default: ${DEFAULT_VRID}

    --cluster-ha                        Global cluster HA address
    --platform-domain                   Platform access address, either an IP or a domain name
    --platform-http                     HTTP port for platform access. Default: ${DEFAULT_PLATFORM_HTTP}. 0 disables HTTP.
    --platform-https                    HTTPS port for platform access. Default: ${DEFAULT_PLATFORM_HTTPS}
    --tls-cert-file                     Path to the TLS certificate file for the platform access address. If not set, a self‑signed certificate is used.
    --tls-key-file                      Path to the TLS private key file for the platform access address. If not set, a self‑signed certificate is used.

    --external-registry-address         External image registry address. If not set, the platform‑deployed registry is used.
    --registry-domain                   Image registry address. When using the platform‑deployed registry, the default value is the same as --cluster-ha.
    --registry-username                 Image registry username. If not set, no username is used.
    --registry-password                 Image registry password. If not set, no password is used.

    --cni-type                          CNI type. Valid values: ovn, calico. Default: ${DEFAULT_CNI_TYPE}
    --dual-stack                        Whether to enable dual stack. Default: ${DEFAULT_DUAL_STACK}
    --network-device                    Network interface name. If not set, no specific interface is configured.

    --cluster-cidr-ipv4                 IPv4 cluster CIDR for the global cluster. Default: ${DEFAULT_CLUSTER_CIDR_IPV4}
    --service-cidr-ipv4                 IPv4 service CIDR for the global cluster. Default: ${DEFAULT_SERVICE_CIDR_IPV4}
    --join-cidr-ipv4                    When CNI is ovn, IPv4 join CIDR for the global cluster. Default: ${DEFAULT_JOIN_CIDR_IPV4}
    --cluster-cidr-ipv6                 IPv6 cluster CIDR for the global cluster. Default: ${DEFAULT_CLUSTER_CIDR_IPV6}
    --service-cidr-ipv6                 IPv6 service CIDR for the global cluster. Default: ${DEFAULT_SERVICE_CIDR_IPV6}
    --join-cidr-ipv6                    When CNI is ovn, IPv6 join CIDR for the global cluster. Default: ${DEFAULT_JOIN_CIDR_IPV6}

    --hostname-as-node-name             Use hostnames as node names. If false, IP addresses are used as node names. Default: ${DEFAULT_HOSTNAME_AS_NODE_NAME}
    --node-isolate                      Enable platform node isolation for the global cluster. When enabled, platform components are restricted to control plane nodes. Default: ${DEFAULT_NODE_ISOLATE}

    --control-planes                    List of control plane servers, IPv4 addresses separated by commas, for example: 192.168.1.1,192.168.1.2,192.168.1.3
    --workers                           List of worker servers, IPv4 addresses separated by commas
    --control-planes-ipv6               IPv6 addresses of the control plane servers. Required for dual stack. Comma‑separated and one‑to‑one mapped to --control-planes
    --workers-ipv6                      IPv6 addresses of the worker servers. Required for dual stack. Comma‑separated and one‑to‑one mapped to --workers
    --control-planes-app-deployable     Allow applications to be deployed on control plane nodes. Default: ${DEFAULT_CONTROL_PLANES_APP_DEPLOYABLE}. This option is ignored when --node-isolate is enabled.

    --ssh-port                          SSH access port. Default: ${DEFAULT_SSH_PORT}
    --ssh-username                      SSH username. Default: ${DEFAULT_SSH_USERNAME}
    --ssh-password                      SSH login password
    --ssh-key-file                      Path to the SSH private key file for login
    --prometheus-nodes                  Nodes on which to deploy Prometheus, IPv4 addresses separated by commas. Empty means do not deploy.
    --victoriametrics-nodes             Nodes on which to deploy VictoriaMetrics, IPv4 addresses separated by commas. Empty means do not deploy.
    --victoriametrics-agent-replicas    Number of VictoriaMetrics Agent replicas to deploy
    --elasticsearch-nodes               Nodes on which to deploy ElasticSearch, IPv4 addresses separated by commas. Empty means do not deploy.
    --node-max-pods                     Maximum number of pods per node. Default: ${DEFAULT_NODE_MAX_PODS}
    --alternative-hosts                 Additional access addresses for the platform, separated by commas
"
}

function parse_args() {
    if [ "$#" -eq "0" ]; then
        usage
        exit 1
    fi
    local args=""
    for a in "${@}"; do
        args="${args} ${a/=/ }"
    done

    IFS=" " read -r -a args <<< "$args"
    set -- "${args[@]}"

    while [ "$#" -gt "0" ]; do
        case "$1" in
            --installer-ip)
                INSTALLER_IP="$2"
                shift
                ;;
            --config-file)
                CONFIG_FILE="$2"
                shift
                ;;
            --dry-run)
                DRY_RUN="$2"
                shift
                ;;
            --wait)
                WAIT="$2"
                shift
                ;;
            --admin-username)
                ADMIN_USERNAME="$2"
                shift
                ;;
            --admin-password)
                ADMIN_PASSWORD="$2"
                shift
                ;;
            --cluster-version)
                CLUSTER_VERSION="$2"
                shift
                ;;
            --cri-version)
                CRI_VERSION="$2"
                shift
                ;;
            --self-vip)
                SELF_VIP="$2"
                shift
                ;;
            --vrid)
                VRID="$2"
                shift
                ;;
            --cluster-ha)
                CLUSTER_HA="$2"
                shift
                ;;
            --platform-domain)
                PLATFORM_DOMAIN="$2"
                shift
                ;;
            --platform-http)
                PLATFORM_HTTP="$2"
                shift
                ;;
            --platform-https)
                PLATFORM_HTTPS="$2"
                shift
                ;;
            --tls-cert-file)
                TLS_CERT_FILE="$2"
                shift
                ;;
            --tls-key-file)
                TLS_KEY_FILE="$2"
                shift
                ;;
            --external-registry-address)
                EXTERNAL_REGISTRY_ADDRESS="$2"
                shift
                ;;
            --registry-domain)
                REGISTRY_DOMAIN="$2"
                shift
                ;;
            --registry-username)
                REGISTRY_USERNAME="$2"
                shift
                ;;
            --registry-password)
                REGISTRY_PASSWORD="$2"
                shift
                ;;
            --cni-type)
                CNI_TYPE="$2"
                shift
                ;;
            --dual-stack)
                DUAL_STACK="$2"
                shift
                ;;
            --cluster-cidr-ipv4)
                CLUSTER_CIDR_IPV4="$2"
                shift
                ;;
            --service-cidr-ipv4)
                SERVICE_CIDR_IPV4="$2"
                shift
                ;;
            --join-cidr-ipv4)
                JOIN_CIDR_IPV4="$2"
                shift
                ;;
            --cluster-cidr-ipv6)
                CLUSTER_CIDR_IPV6="$2"
                shift
                ;;
            --service-cidr-ipv6)
                SERVICE_CIDR_IPV6="$2"
                shift
                ;;
            --join-cidr-ipv6)
                JOIN_CIDR_IPV6="$2"
                shift
                ;;
            --network-device)
                NETWORK_DEVICE="$2"
                shift
                ;;
            --hostname-as-node-name)
                HOSTNAME_AS_NODE_NAME="$2"
                shift
                ;;
            --node-isolate)
                NODE_ISOLATE="$2"
                shift
                ;;
            --control-planes)
                CONTROL_PLANES="$2"
                shift
                ;;
            --workers)
                WORKERS="$2"
                shift
                ;;
            --control-planes-ipv6)
                CONTROL_PLANES_IPV6="$2"
                shift
                ;;
            --workers-ipv6)
                WORKERS_IPV6="$2"
                shift
                ;;
            --control-planes-app-deployable)
                CONTROL_PLANES_APP_DEPLOYABLE="$2"
                shift
                ;;
            --ssh-port)
                SSH_PORT="$2"
                shift
                ;;
            --ssh-username)
                SSH_USERNAME="$2"
                shift
                ;;
            --ssh-password)
                SSH_PASSWORD="$2"
                shift
                ;;
            --ssh-key-file)
                SSH_KEY_FILE="$2"
                shift
                ;;
            --prometheus-nodes)
                PROMETHEUS_NODES="$2"
                shift
                ;;
            --victoriametrics-nodes)
                VICTORIAMETRICAS_NODES="$2"
                shift
                ;;
            --prometheus-agent-replicas)
                VICTORIAMETRICAS_AGENT_REPLICAS="$2"
                shift
                ;;
            --elasticsearch-nodes)
                ELASTICSEARCH_NODES="$2"
                shift
                ;;
            --node-max-pods)
                NODE_MAX_PODS="$2"
                shift
                ;;
            --alternative-hosts)
                ALTERNATIVE_HOSTS="$2"
                shift
                ;;
            --products)
                PRODUCTS="$2"
                shift
                ;;
            *)
                if [ -n "$1" ]; then
                    echo "未知参数: $1"
                    usage
                    exit 1
                fi
                break
                ;;
        esac
        shift
    done
}

function print_args() {
    if [ "${USE_EXIST_CONFIG_FILE}" = "true" ]; then
        echo "
----------------------------ARGS-------------------------------
INSTALLER_IP:                    ${INSTALLER_IP}
INSTALLER_ENDPOINT:              ${INSTALLER_ENDPOINT}
CONFIG_FILE:                     ${CONFIG_FILE}
USE_EXIST_CONFIG_FILE:           ${USE_EXIST_CONFIG_FILE}
DRY_RUN:                         ${DRY_RUN}
WAIT:                            ${WAIT}
---------------------------------------------------------------
"
    else
        echo "
----------------------------ARGS-------------------------------
INSTALLER_IP:                    ${INSTALLER_IP}
INSTALLER_ENDPOINT:              ${INSTALLER_ENDPOINT}
CONFIG_FILE:                     ${CONFIG_FILE}
USE_EXIST_CONFIG_FILE:           ${USE_EXIST_CONFIG_FILE}
DRY_RUN:                         ${DRY_RUN}
WAIT:                            ${WAIT}

ADMIN_USERNAME:                  ${ADMIN_USERNAME}
ADMIN_PASSWORD:                  ${ADMIN_PASSWORD}

CLUSTER_VERSION:                 ${CLUSTER_VERSION}
CRI_VERSION:                     ${CRI_VERSION}

SELF_VIP:                        ${SELF_VIP}
VRID:                            ${VRID}

CLUSTER_HA:                      ${CLUSTER_HA}
PLATFORM_DOMAIN:                 ${PLATFORM_DOMAIN}
PLATFORM_HTTP:                   ${PLATFORM_HTTP}
PLATFORM_HTTPS:                  ${PLATFORM_HTTPS}
TLS_SELF_SIGNED:                 ${TLS_SELF_SIGNED}
TLS_CERT_FILE:                   ${TLS_CERT_FILE}
TLS_KEY_FILE:                    ${TLS_KEY_FILE}

EXTERNAL_REGISTRY_ADDRESS:       ${EXTERNAL_REGISTRY_ADDRESS}
REGISTRY_DOMAIN:                 ${REGISTRY_DOMAIN}
REGISTRY_USERNAME:               ${REGISTRY_USERNAME}
REGISTRY_PASSWORD:               ${REGISTRY_PASSWORD}

CNI_TYPE:                        ${CNI_TYPE}
DUAL_STACK:                      ${DUAL_STACK}

CLUSTER_CIDR_IPV4:               ${CLUSTER_CIDR_IPV4}
SERVICE_CIDR_IPV4:               ${SERVICE_CIDR_IPV4}
JOIN_CIDR_IPV4:                  ${JOIN_CIDR_IPV4}

CLUSTER_CIDR_IPV6:               ${CLUSTER_CIDR_IPV6}
SERVICE_CIDR_IPV6:               ${SERVICE_CIDR_IPV6}
JOIN_CIDR_IPV6:                  ${JOIN_CIDR_IPV6}

NETWORK_DEVICE:                  ${NETWORK_DEVICE}

HOSTNAME_AS_NODE_NAME:           ${HOSTNAME_AS_NODE_NAME}
NODE_ISOLATE:                    ${NODE_ISOLATE}
CONTROL_PLANES_APP_DEPLOYABLE:   ${CONTROL_PLANES_APP_DEPLOYABLE}

CONTROL_PLANES:                  ${CONTROL_PLANES}
WORKERS:                         ${WORKERS}
SSH_PORT:                        ${SSH_PORT}
SSH_USERNAME:                    ${SSH_USERNAME}
SSH_PASSWORD:                    ${SSH_PASSWORD}
SSH_KEY_FILE:                    ${SSH_KEY_FILE}

PROMETHEUS_NODES:                ${PROMETHEUS_NODES}
VICTORIAMETRICAS_NODES:          ${VICTORIAMETRICAS_NODES}
VICTORIAMETRICAS_AGENT_REPLICAS: ${VICTORIAMETRICAS_AGENT_REPLICAS}
ELASTICSEARCH_NODES:             ${ELASTICSEARCH_NODES}

NODE_MAX_PODS:                   ${NODE_MAX_PODS}

ALTERNATIVE_HOSTS:               ${ALTERNATIVE_HOSTS}
PRODUCTS:                        ${PRODUCTS}
---------------------------------------------------------------
"
    fi
}

CONTROL_PLANES_ARR=()
WORKERS_ARR=()
CONTROL_PLANES_IPV6_ARR=()
WORKERS_IPV6_ARR=()
PROMETHEUS_NODES_ARR=()
ELASTICSEARCH_NODES_ARR=()
VICTORIAMETRICAS_NODES_ARR=()
ALTERNATIVE_HOSTS_ARR=()
PRODUCTS_ARR=()

function check_args() {
    if [ -z "${INSTALLER_ENDPOINT}" ]; then
        INSTALLER_ENDPOINT="http://${INSTALLER_IP}:8080"
    fi

    if [ -z "${DRY_RUN}" ]; then
        DRY_RUN="false"
    fi
    if [ "${DRY_RUN}" != "false" ]; then
        DRY_RUN="true"
    fi

    if [ -z "${WAIT}" ]; then
        WAIT="true"
    fi
    if [ "${WAIT}" != "true" ]; then
        WAIT="false"
    fi

    if [ -z "${CONFIG_FILE}" ]; then
        CONFIG_FILE="$(mktemp)"
        USE_EXIST_CONFIG_FILE="false"
    else
        if [ ! -f "${CONFIG_FILE}" ]; then
            echo "配置文件: ${CONFIG_FILE} 不存在"
            return 2
        else
            USE_EXIST_CONFIG_FILE="true"
        fi
    fi

    if [ -z "${ADMIN_USERNAME}" ]; then
        echo "管理员用户名不能为空"
        return 2
    fi

    if [ -z "${ADMIN_PASSWORD}" ]; then
        echo "管理员密码不能为空"
        return 2
    fi

    if [ -n "${TLS_CERT_FILE}" ]; then
        if [ ! -f "${TLS_CERT_FILE}" ]; then
            echo "tls 证书文件: ${TLS_CERT_FILE} 不存在"
            return 2
        fi
    fi

    if [ -n "${TLS_KEY_FILE}" ]; then
        if [ ! -f "${TLS_KEY_FILE}" ]; then
            echo "tls 私钥文件: ${TLS_KEY_FILE} 不存在"
            return 2
        fi
    fi

    if [ -z "${TLS_CERT_FILE}" ] && [ -z "${TLS_KEY_FILE}" ]; then
        TLS_SELF_SIGNED="true"
    else
        TLS_SELF_SIGNED="false"

        if [[ -z "${TLS_CERT_FILE}" ]] || [[ -z "${TLS_KEY_FILE}" ]]; then
             echo "tls 证书文件和私钥文件必须同时设置"
             return 2
        fi
    fi

    if [ -n "${SSH_KEY_FILE}" ]; then
        if [ ! -f "${SSH_KEY_FILE}" ]; then
            echo "ssh 登录密钥文件路径: ${SSH_KEY_FILE} 不存在"
            return 2
        fi
    fi

    IFS=',' read -r -a CONTROL_PLANES_ARR <<< "${CONTROL_PLANES}"
    IFS=',' read -r -a WORKERS_ARR <<< "${WORKERS}"
    IFS=',' read -r -a PROMETHEUS_NODES_ARR <<< "${PROMETHEUS_NODES}"
    IFS=',' read -r -a ELASTICSEARCH_NODES_ARR <<< "${ELASTICSEARCH_NODES}"
    IFS=',' read -r -a VICTORIAMETRICAS_NODES_ARR <<< "${VICTORIAMETRICAS_NODES}"

    if [ ${#CONTROL_PLANES_ARR[@]} -ne '3' ] && [ ${#CONTROL_PLANES_ARR[@]} -ne '1' ]; then
        echo "控制节点数量必须为3或1"
        return 2
    fi

    if [ "${#PROMETHEUS_NODES_ARR[@]}" -gt "0" ] && [ "${#VICTORIAMETRICAS_NODES_ARR[@]}" -gt "0" ]; then
        echo "不能同时部署 Prometheus 和 VictoriaMetrics"
        return 2
    fi

    if [ "${#VICTORIAMETRICAS_NODES_ARR[@]}" -gt "0" ] && [ "${VICTORIAMETRICAS_AGENT_REPLICAS}" -le "0" ]; then
        VICTORIAMETRICAS_AGENT_REPLICAS=1
    fi

    local i j found

    for i in "${PROMETHEUS_NODES_ARR[@]}"; do
        found="false"
        for j in "${CONTROL_PLANES_ARR[@]}"; do
            if [ "$i" = "$j" ]; then
                found="true"
                break
            fi
        done
        if [ "${found}" = "false" ]; then
            for j in "${WORKERS_ARR[@]}"; do
                if [ "$i" = "$j" ]; then
                    found="true"
                    break
                fi
            done
        fi
        if [ "${found}" = "false" ]; then
            echo  "控制节点和计算节点中找不到 Prometheus 节点: ${i}"
            return 2
        fi
    done

    for i in "${VICTORIAMETRICAS_NODES_ARR[@]}"; do
        found="false"
        for j in "${CONTROL_PLANES_ARR[@]}"; do
            if [ "$i" = "$j" ]; then
                found="true"
                break
            fi
        done
        if [ "${found}" = "false" ]; then
            for j in "${WORKERS_ARR[@]}"; do
                if [ "$i" = "$j" ]; then
                    found="true"
                    break
                fi
            done
        fi
        if [ "${found}" = "false" ]; then
            echo  "控制节点和计算节点中找不到 VictoriaMetrics 节点: ${i}"
            return 2
        fi
    done

    for i in "${ELASTICSEARCH_NODES_ARR[@]}"; do
        found="false"
        for j in "${CONTROL_PLANES_ARR[@]}"; do
            if [ "$i" = "$j" ]; then
                found="true"
                break
            fi
        done
        if [ "${found}" = "false" ]; then
            for j in "${WORKERS_ARR[@]}"; do
                if [ "$i" = "$j" ]; then
                    found="true"
                    break
                fi
            done
        fi
        if [ "${found}" = "false" ]; then
            echo "控制节点和计算节点中找不到 ElasticSearch 节点: ${i}"
            return 2
        fi
    done

    if ! { [ "${SSH_PORT}" -ge "1" ] && [ "${SSH_PORT}" -le "65535" ]; }; then
        echo "ssh 访问端口取值: 1-65535"
        return 2
    fi

    if [ -z "${SSH_USERNAME}" ]; then
        echo "ssh 用户名不能为空"
        return 2
    fi

    if [ -z "${CLUSTER_VERSION}" ]; then
        echo "必须指定 global 集群的 k8s 版本。 Must specify the k8s version of the global cluster"
        return 2
    fi

    if [ -z "${CLUSTER_HA}" ]; then
        echo "global 集群 HA 地址不能为空"
        return 2
    fi

    if echo "${CLUSTER_HA}" | grep -q ":"; then
        echo "global 集群 HA 地址不合法, 不能包含冒号"
        return 2
    fi

    if ! { [ "${PLATFORM_HTTP}" -ge "0" ] && [ "${PLATFORM_HTTP}" -le "65535" ]; }; then
        echo "平台访问的 HTTP 端口取值: 0-65535"
        return 2
    fi

    if ! { [ "${PLATFORM_HTTPS}" -ge "1" ] && [ "${PLATFORM_HTTPS}" -le "65535" ]; }; then
        echo "平台访问的 HTTPS 端口取值: 1-65535"
        return 2
    fi

    if [ -z "${SELF_VIP}" ]; then
        SELF_VIP="false"
    fi
    if [ "${SELF_VIP}" != "false" ]; then
        SELF_VIP="true"
    fi

    if [ "${SELF_VIP}" = "true" ]; then
        if ! { [ "${VRID}" -ge "1" ] && [ "${VRID}" -le "255" ]; }; then
            echo "VRID 取值: 1-255"
            return 2
        fi
    fi

    if [ -z "${EXTERNAL_REGISTRY_ADDRESS}" ]; then
        if [ -z "${REGISTRY_DOMAIN}" ]; then
            REGISTRY_DOMAIN="${CLUSTER_HA}"
        fi
    else
        REGISTRY_DOMAIN=""
    fi

    if [ -z "${CLUSTER_CIDR_IPV4}" ]; then
        echo "global 集群的 ipv4 cluster CIDR 不能为空"
        return 2
    fi

    if [ -z "${SERVICE_CIDR_IPV4}" ]; then
        echo "global 集群的 ipv4 service CIDR 不能为空"
        return 2
    fi

    if [ "${CNI_TYPE}" = "ovn" ] && [ -z "${JOIN_CIDR_IPV4}" ]; then
        echo "global 集群的 ipv4 join CIDR 不能为空"
        return 2
    fi

    if [ -z "${DUAL_STACK}" ]; then
        DUAL_STACK="false"
    fi
    if [ "${DUAL_STACK}" != "false" ]; then
        DUAL_STACK="true"
    fi
    if [ "${DUAL_STACK}" = "true" ]; then
        if [ -z "${CLUSTER_CIDR_IPV6}" ]; then
            echo "global 集群的 ipv6 cluster CIDR 不能为空"
            return 2
        fi

        if [ -z "${SERVICE_CIDR_IPV6}" ]; then
            echo "global 集群的 ipv6 service CIDR 不能为空"
            return 2
        fi
        if [ "${CNI_TYPE}" = "ovn" ] && [ -z "${JOIN_CIDR_IPV6}" ]; then
            echo "global 集群的 ipv6 join CIDR 不能为空"
            return 2
        fi

        IFS=',' read -r -a CONTROL_PLANES_IPV6_ARR <<< "${CONTROL_PLANES_IPV6}"
        IFS=',' read -r -a WORKERS_IPV6_ARR <<< "${WORKERS_IPV6}"

        if [ ${#CONTROL_PLANES_ARR[@]} -ne ${#CONTROL_PLANES_IPV6_ARR[@]} ]; then
            echo "控制节点的 IPv4 与 IPv6 数量不一致"
            return 2
        fi
        if [ ${#WORKERS_ARR[@]} -ne ${#WORKERS_IPV6_ARR[@]} ]; then
            echo "计算节点的 IPv4 与 IPv6 数量不一致"
            return 2
        fi
    fi


    if [ -z "${CONTROL_PLANES_APP_DEPLOYABLE}" ]; then
        CONTROL_PLANES_APP_DEPLOYABLE="false"
    fi
    if [ "${CONTROL_PLANES_APP_DEPLOYABLE}" != "false" ]; then
        CONTROL_PLANES_APP_DEPLOYABLE="true"
    fi

    if [ -z "${NODE_ISOLATE}" ]; then
        NODE_ISOLATE="false"
    fi
    if [ "${NODE_ISOLATE}" != "false" ]; then
        NODE_ISOLATE="true"
        CONTROL_PLANES_APP_DEPLOYABLE="false"
    fi

    if [ -z "${HOSTNAME_AS_NODE_NAME}" ]; then
        HOSTNAME_AS_NODE_NAME="false"
    fi
    if [ "${HOSTNAME_AS_NODE_NAME}" != "false" ]; then
        HOSTNAME_AS_NODE_NAME="true"
    fi

    IFS=',' read -r -a ALTERNATIVE_HOSTS_ARR <<< "${ALTERNATIVE_HOSTS}"
    IFS=',' read -r -a PRODUCTS_ARR <<< "${PRODUCTS}"

    for i in "base" "acp"; do
        found=false
        for j in "${PRODUCTS_ARR[@]}"; do
             if [ "$i" = "$j" ]; then
                found="true"
                break
            fi
        done
        if [ "${found}" = "false" ]; then
            echo "必须部署产品 ${i}"
            return 2
        fi
    done
    return 0
}

function json_json_string() {
    local idx=0 n=${#} r='[' args
    IFS=' ' read -r -a args <<< "$@"

    while [ "$idx" -lt "$n" ]; do
        r="${r}\"${args[${idx}]}\""
        idx=$((idx + 1))
        if [ "$idx" -lt "$n" ]; then
            r="${r}, "
        fi
    done
    r="${r}]"
    echo "${r}"
}

function output_config() {
    mkdir -p "$(dirname "${CONFIG_FILE}")"
    local ssh_password='null' ssh_key='null' labels='null' deploy_mode="normal"
    local svc_cidr="${SERVICE_CIDR_IPV4}" cluster_cidr="${CLUSTER_CIDR_IPV4}" join_cidr="${JOIN_CIDR_IPV4}"
    local install_es="false" install_prome="false" install_vm="false"
    local i ipv6 registry_domain registry_password machines third_party_ha vrid cert taints cluster_annotations
    if [ -n "${REGISTRY_USERNAME}" ] && [ -n "${REGISTRY_PASSWORD}" ]; then
        registry_password=$(echo -n "${REGISTRY_PASSWORD}" | base64 -w 0)
    fi

    if [ -n "${REGISTRY_DOMAIN}" ]; then
        registry_domain="${REGISTRY_DOMAIN}:11443"
    fi

    if [ "${DUAL_STACK}" = "true" ]; then
        svc_cidr="${SERVICE_CIDR_IPV4},${SERVICE_CIDR_IPV6}"
        cluster_cidr="${CLUSTER_CIDR_IPV4},${CLUSTER_CIDR_IPV6}"
        join_cidr="${JOIN_CIDR_IPV4},${JOIN_CIDR_IPV6}"
    fi

    cluster_annotations="{
            \"cpaas.io/container-runtime\": \"${CRI_VERSION}\",
            \"cpaas.io/network-type\": \"${CNI_TYPE}\"
        }"
    if [ "${CNI_TYPE}" = "ovn" ]; then
        cluster_annotations="{
            \"cpaas.io/container-runtime\": \"${CRI_VERSION}\",
            \"cpaas.io/network-type\": \"${CNI_TYPE}\",
            \"kube-ovn.cpaas.io/join-cidr\": \"${join_cidr}\",
            \"kube-ovn.cpaas.io/transmit-type\": \"overlay\"
        }"
    fi

    if [ "${TLS_SELF_SIGNED}" = "true" ]; then
        cert='"selfSigned": {}'
    else
        cert="\"thirdParty\": {
                \"certificate\": \"$(base64 -w 0 "${TLS_CERT_FILE}")\",
                \"privateKey\": \"$(base64 -w 0 "${TLS_KEY_FILE}")\"
            }"
    fi

    if [ "${SELF_VIP}"  == "true" ]; then
        third_party_ha="false"
        vrid="${VRID}"
    else
        third_party_ha="true"
        vrid="null"
    fi

    if [ -n "${SSH_PASSWORD}" ]; then
        ssh_password="$(echo -n "${SSH_PASSWORD}" | base64 -w 0)"
    fi

    if [ -f "${SSH_KEY_FILE}" ]; then
        ssh_key="\"$(base64 -w 0 "${SSH_KEY_FILE}")\""
    fi

    taints='[]'
    if [ "${CONTROL_PLANES_APP_DEPLOYABLE}" = "false" ]; then
         taints='[{ "key": "node-role.kubernetes.io/master", "effect": "NoSchedule" }]'
    fi

    if [ "${NODE_ISOLATE}" = "true" ]; then
        deploy_mode="base"
        labels='{ "node-role.kubernetes.io/cpaas-system": "true" }'
        taints='[{ "key": "node-role.kubernetes.io/master", "effect": "NoSchedule" }, { "key": "node-role.kubernetes.io/cpaas-system", "effect": "NoSchedule" }]'
    fi

    machines='['
    for i in "${!CONTROL_PLANES_ARR[@]}"; do
        if [ "${DUAL_STACK}" = "true" ]; then
            ipv6="${CONTROL_PLANES_IPV6_ARR["$i"]}"
        else
            ipv6=""
        fi
        machines="${machines}{
                \"ip\": \"${CONTROL_PLANES_ARR[$i]}\",
                \"ipv6\": \"${ipv6}\",
                \"port\": ${SSH_PORT},
                \"username\": \"${SSH_USERNAME}\",
                \"password\": \"${ssh_password}\",
                \"privateKey\": ${ssh_key},
                \"labels\": ${labels},
                \"taints\": ${taints},
                \"role\": \"master\"
            }"

        if [ "$((i + 1))" -lt "${#CONTROL_PLANES_ARR[@]}" ] || [ "${#WORKERS_ARR[@]}" -gt "0" ]; then
            machines="${machines}, "
        fi
    done

    for i in "${!WORKERS_ARR[@]}"; do
        if [ "${DUAL_STACK}" = "true" ]; then
            ipv6="${WORKERS_IPV6_ARR["$i"]}"
        else
            ipv6=""
        fi
        machines="${machines} {
                \"ip\": \"${WORKERS_ARR[$i]}\",
                \"ipv6\": \"${ipv6}\",
                \"port\": ${SSH_PORT},
                \"username\": \"${SSH_USERNAME}\",
                \"password\": \"${ssh_password}\",
                \"privateKey\": ${ssh_key},
                \"role\": \"node\"
            }"

        if [ "$((i + 1))" -lt "${#WORKERS_ARR[@]}" ]; then
            machines="${machines}, "
        fi
    done
    machines="${machines}]"

    if [ "${#ELASTICSEARCH_NODES_ARR[@]}" -gt "0" ]; then
        install_es="true"
    fi

    if [ "${#PROMETHEUS_NODES_ARR[@]}" -gt "0" ]; then
        install_prome="true"
    fi

    if [ "${#VICTORIAMETRICAS_NODES_ARR[@]}" -gt "0" ]; then
        install_vm="true"
    fi

    cat << EOF > "${CONFIG_FILE}"
{
    "basic": {
        "username": "${ADMIN_USERNAME}",
        "password": "$(echo -n "${ADMIN_PASSWORD}" | base64 -w 0)"
    },
    "console": {
        "globalHost": "${PLATFORM_DOMAIN}",
        "host": $(json_json_string "${ALTERNATIVE_HOSTS_ARR[@]}"),
        "cert": {
           ${cert}
        },
        "httpsPort": ${PLATFORM_HTTPS},
        "httpPort": ${PLATFORM_HTTP}
    },
    "deployMode": "${deploy_mode}",
    "registry": {
        "externalAddress": "${EXTERNAL_REGISTRY_ADDRESS}",
        "domain": "${registry_domain}",
        "username": "${REGISTRY_USERNAME}",
        "password": "${registry_password}"
    },
    "cluster": {
        "version": "${CLUSTER_VERSION}",
        "networkDevice": "${NETWORK_DEVICE}",
        "properties": {
           "maxNodePodNum": ${NODE_MAX_PODS}
        },
        "features": {
            "ipv6DualStack": ${DUAL_STACK},
            "ha": {
                "vip": "${CLUSTER_HA}",
                "vport": 6443,
                "isThirdParty": ${third_party_ha},
                "vrid": ${vrid}
            },
            "machines": ${machines},
            "gpuType": ""
        },
        "clusterCIDR": "${cluster_cidr}",
        "serviceCIDR": "${svc_cidr}",
        "kubeletExtraArgs": {},
        "dockerExtraArgs": {},
        "apiServerExtraArgs": {},
        "controllerManagerExtraArgs": {},
        "schedulerExtraArgs": {},
        "annotations": ${cluster_annotations},
        "hostnameAsNodename": ${HOSTNAME_AS_NODE_NAME}
    },
    "product": $(json_json_string "${PRODUCTS_ARR[@]}"),
    "elasticSearch": {
        "nodes": $(json_json_string "${ELASTICSEARCH_NODES_ARR[@]}"),
        "runOnMaster": ${install_es},
        "isUseDefault": true
    },
    "prometheus": {
        "nodes": $(json_json_string "${PROMETHEUS_NODES_ARR[@]}"),
        "runOnMaster": ${install_prome}
    },
    "victoriametrics": {
        "nodes": $(json_json_string "${VICTORIAMETRICAS_NODES_ARR[@]}"),
        "agentReplicas": ${VICTORIAMETRICAS_AGENT_REPLICAS},
        "runOnMaster": ${install_vm}
    }
}
EOF
}

function install() {
    local code output

    output=$(mktemp)
    mkdir -p "$(dirname "${output}")"

    code=$(curl  -w "%{http_code}" -s -o "${output}" -X POST "${INSTALLER_ENDPOINT}/api/config" -d "@${CONFIG_FILE}" -H "Content-Type: application/json")
    if [ "${code}" -ne "200" ]; then
        echo "Install Failed: response code is ${code}, output is:"
        cat "${output}"
        rm -f "${output}"
        return 1
    fi
    rm -f "${output}"
    return 0
}

function wait_install() {
    local resp
    local faild_times=0
    while true; do
        resp=$(curl -s -X GET "${INSTALLER_ENDPOINT}/api/progress")
        if echo "${resp}" | grep "Success"; then
            echo "$(date +'%Y-%m-%d %H:%M:%S'): Install Success"
            return 0
        fi

        if echo "${resp}" | grep "Failed"; then
            faild_times=$((faild_times + 1))
            if [[ ${faild_times} -ge "5"   ]]; then
                echo "$(date +'%Y-%m-%d %H:%M:%S'): Install Failed: "
                echo "${resp}"
                return 1
            fi
        else
            echo "$(date +'%Y-%m-%d %H:%M:%S'): Installing... step $(echo "${resp}" | grep 'step' | awk '{print $2}' | tr -d ',')"
        fi
        sleep 10
    done
}

function main() {
    parse_args "$@"

    if ! check_args; then
        usage
        exit 2
    fi

    print_args

    if [ "${USE_EXIST_CONFIG_FILE}" = "false" ]; then
        if ! output_config; then
            exit 3
        fi
    fi

    echo "Platform Config:"
    cat "${CONFIG_FILE}"

    if [ "${DRY_RUN}" = "false" ]; then
        if ! install; then
            exit 4
        fi

        if  [ "${WAIT}" = "true" ]; then
            if ! wait_install; then
                exit 5
            fi
        fi
    fi
}

main "${@}"
