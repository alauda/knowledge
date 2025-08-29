import { useI18n, usePageData } from "@rspress/core/runtime";

const EDIT_LINK = {
  docRepoBaseUrl: "https://github.com/alauda/knowledge/",
};

function useEditLink() {
  const { page } = usePageData();

  const { docRepoBaseUrl } = EDIT_LINK;

  const relativePagePath = (page._relativePath as string).replace(/\\/g, "/");
  const editLink = `${docRepoBaseUrl}edit/main/docs/${relativePagePath}`;
  const issueLink = `${docRepoBaseUrl}issues/new`;

  return {
    editLink,
    issueLink,
  };
}

function GithubIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={18} viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12c0 5.303 3.438 9.8 8.205 11.385c.6.113.82-.258.82-.577c0-.285-.01-1.04-.015-2.04c-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729c1.205.084 1.838 1.236 1.838 1.236c1.07 1.835 2.809 1.305 3.495.998c.108-.776.417-1.305.76-1.605c-2.665-.3-5.466-1.332-5.466-5.93c0-1.31.465-2.38 1.235-3.22c-.135-.303-.54-1.523.105-3.176c0 0 1.005-.322 3.3 1.23c.96-.267 1.98-.399 3-.405c1.02.006 2.04.138 3 .405c2.28-1.552 3.285-1.23 3.285-1.23c.645 1.653.24 2.873.12 3.176c.765.84 1.23 1.91 1.23 3.22c0 4.61-2.805 5.625-5.475 5.92c.42.36.81 1.096.81 2.22c0 1.606-.015 2.896-.015 3.286c0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={18} viewBox="0 0 512 512">
      <path
        fill="currentColor"
        d="M471.6 21.7c-21.9-21.9-57.3-21.9-79.2 0L362.3 51.7l97.9 97.9 30.1-30.1c21.9-21.9 21.9-57.3 0-79.2L471.6 21.7zm-299.2 220c-6.1 6.1-10.8 13.6-13.5 21.9l-29.6 88.8c-2.9 8.6-.6 18.1 5.8 24.6s15.9 8.7 24.6 5.8l88.8-29.6c8.2-2.7 15.7-7.4 21.9-13.5L437.7 172.3 339.7 74.3 172.4 241.7zM96 64C43 64 0 107 0 160L0 416c0 53 43 96 96 96l256 0c53 0 96-43 96-96l0-96c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 96c0 17.7-14.3 32-32 32L96 448c-17.7 0-32-14.3-32-32l0-256c0-17.7 14.3-32 32-32l96 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L96 64z"
      />
    </svg>
  );
}

export const EditOnGithub = () => {
  const { editLink, issueLink } = useEditLink();
  const t = useI18n();

  return (
    <div className="mb-2">
      <div className="editLink">
        <a href={editLink} target="_blank" className="flex">
          <EditIcon></EditIcon>
          <span className="ml-2">{t("edit_page")}</span>
        </a>
      </div>
      <div className="editLink">
        <a href={issueLink} target="_blank" className="flex">
          <GithubIcon></GithubIcon>
          <span className="ml-2">{t("create_issue")}</span>
        </a>
      </div>
    </div>
  );
};
