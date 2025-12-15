---
id: KBxxx
products:
  - Alauda Container Platform
kind:
  - Solution
---

# Using Red Hat UBI Images in ACP

**NOTE**

ACP (Alauda Container Platform) is highly compatible with OpenShift, and we recommend and fully support the use of the Red Hat UBI (Universal Base Image) series of images. UBI is completely open source and regularly receives security patches, which can significantly enhance business security. All UBI images can be seamlessly built and run on ACP, allowing you to directly use your existing UBI-based images and processes without any modifications.

---

## UBI Overview

The Red Hat Universal Base Image (UBI) is a container base image provided by Red Hat, built upon a subset of Red Hat Enterprise Linux (RHEL), and supports the OCI standard.  
It allows developers to freely build  and run containerized applications without requiring a Red Hat subscription.

### UBI Image Types

- **Base Images**: ubi (Standard), ubi-minimal, ubi-micro, ubi-init
- **Language Runtimes and Frameworks**: Go, Node.js, Ruby, Python, PHP, Perl, etc.
- **Web Server**: Apache httpd
- Others

## UBI Image Usage

1. On the official [Red Hat Ecosystem Catalog](https://catalog.redhat.com/en) page, select the "Containers" category and enter the image name you want to search for.
2. After clicking on the desired image in the search results, click the "Get this image" Tab on the detail page, select "Unauthenticated," and obtain the image address.
3. Copy the image address, which can use a tag or a sha. Image address examples:
   - registry.access.redhat.com/ubi9/ubi-minimal:9.7-1764578379
   - registry.access.redhat.com/ubi9/ubi-minimal@sha256:161a4e29ea482bab6048c2b36031b4f302ae81e4ff18b83e61785f40dc576f5d

**Note**: Images under the "Unauthenticated" Tab can be pulled anonymously, and their repository address is _registry.access.redhat.com_. However, some images are located at _registry.redhat.io_ (under the "Using registry tokens" or "Using Red Hat login" Tab) and require pulling via a Red Hat account. For details, refer to: [Red Hat Container Registry Authentication](https://access.redhat.com/articles/RegistryAuthentication).

## Important Note

The Red Hat Universal Base Image is free to deploy on Red Hat or non-Red Hat platforms and freely redistributable. Software vendors and community projects which build on UBI may have additional EULAs which apply to their layered software. Please refer to the [End User License Agreement for the Red Hat Universal Base Image](https://www.redhat.com/licenses/EULA_Red_Hat_Universal_Base_Image_English_20190422.pdf) for information about use of the Red Hat Universal Base Image and associated software and source code.
