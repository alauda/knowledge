---
products: 
   - Alauda Container Platform
kind:
   - Solution
---
# How to add a health check for ACP clusters
## Overview
The ALB health check port, which is pre-installed in each cluster, serves as an endpoint for monitoring cluster health status. If this port becomes inaccessible, it indicates that the cluster is in an unhealthy state.
## Prerequisites
When utilizing the ALB health check port for cluster health monitoring in a VIP-based access configuration, it is mandatory to set up port forwarding rules on the Virtual IP (VIP) for the designated health check port. Failure to configure this port forwarding will result in non-functional health checks.
## Config Vip Health Check
The following table specifies the required configuration parameters for Virtual IP (VIP) health check implementation:

| Health Check Parameters | Description      |
| -------- | -------- |
| Address  | the address of ALB |
| Port     | 11782 |
| Protocol | The protocol type of the health check, it is recommended to use TCP. |
| Response Timeout | The time required to receive the health check response, it is recommended to configure it to 2 seconds. |
| Check Interval | The time interval for the health check, it is recommended to configure it to 5 seconds. |
| Unhealthy Threshold | The number of consecutive failures after which the health check status of the backend server is determined to be failed, it is recommended to configure it to 3 times. |    