# Introduction

Alauda Knowledge hosts Alauda\'s solution articles and technical references.

# Article Writing Guide
## Path Structure
- \`docs/\`\: This directory stores knowledge base articles displayed on Alauda Cloud\.
- \`deprecated/\`\: This directory stores deprecated articles\. When articles become obsolete\, they must be moved here\. 

## Writing Standards 

Note：Knowledge base articles support MD format only\! 

## Properties

Define article properties in frontmatter\:

| Property    | Description |
|-------------|-------------|
| Product     | Applicable products\. Presets include\:<br>\- Alauda Container Platform<br>\- Alauda DevOps<br>\- Alauda AI<br>\- Alauda Application Services<br>\- Alauda Service Mesh<br>\- Alauda Developer Portal |
| Kind        |  -  Solution：Solve specific problems that has been raised with Alauda\.<br> - Article：Technical briefs\, reference architectures\, and early stages of documentation\. |
| ID          | Automatically generated during build\. \*\*Do not modify\*\* this field after creation\.  |

Example：
```
products
   - Alauda Container Platform
   - Alauda Container Platform
   - Alauda DevOps
   - Alauda AI
   - Alauda Application Services
   - Alauda Service Mesh
   - Alauda Developer Portal
kind
   - Solution
```

## Referencing Resources
### Referencing Static Assets

Two supported asset directory types\:

- Global assets\: docs/public/
    \* Use syntax\: \!\[\]\(/image\.png\)
- Article\-specific assets\: 
    \* Use syntax\: \!\[\]\(\./assets/image\.png\)

Recommendation:
- Use public/ for globally shared assets
- Use assets/ for module/article\-specific resources

Static assets require English versions only.

### Linking Within Site

Link to other documents within the current site\:
Use relative links\, for example\: \[docname\]\(\./module/guides/xxx\.md\)

Link to specific sections in other documents\:
Add an anchor to the section heading\, then reference it using the anchor link\. For example\:
```
    {/* Add anchor at referenced location */}
    \#\# Hello World \{\#custom\_id}
    {/* Use anchor links at reference locations */}
    [chaptername](./module/guides/xxx.md#custom_id)
```
Anchor rules: Lowercase letters, numbers, underscores only.

### External References
 Prioritize English\-language sources when available.

### For large files
Use public URLs if available.

Contact administrators for storage need.

# Templates
 A template for Solution\-type articles is provided at\: \[Template Link\]
