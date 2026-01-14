import { useI18n } from "@rspress/core/runtime";

interface StyledProps {
  className?: string;
}

interface BannerProps extends StyledProps {
  className?: string;
}

export const HomeBanner: React.FC<BannerProps> = ({ className }) => {
  const t = useI18n<typeof import("i18n")>();

  // const logo =
  //   typeof pageData.siteData.logo === "string"
  //     ? pageData.siteData.logo
  //     : pageData.siteData.themeConfig.darkMode
  //     ? pageData.siteData.logo.dark
  //     : pageData.siteData.logo.light;

  return (
    <div className={className}>
      <div className="max-w-3/5">
        <h1 className="!text-4xl !font-bold !mb-6">
          {/* {pageData.siteData.title} */}
          {t("knowledge_title")}
        </h1>
        <p className="text-xl !font-semibold ">
          {/* {pageData.siteData.description} */}
          {t("knowledge_description")}
        </p>
      </div>
      {/* <img width={240} src={logo}></img> */}
    </div>
  );
};
