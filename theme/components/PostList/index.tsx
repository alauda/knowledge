import { FC, useMemo } from "react";
import { PostInfo } from "../../../plugins/plugin-post-resolver";
import { Badge, LastUpdated, LinkCard } from "rspress/theme";
import { Marked } from "@ts-stack/markdown";
import { useI18n, usePageData } from "rspress/runtime";
import EmptyState from "../Empty";
import { DocID } from "../DocID";

interface PostListProps {
  postList: PostInfo[];
}

export const PostList: FC<PostListProps> = ({ postList }) => {
  const notEmpty = useMemo(() => postList.length > 0, [postList]);

  const { siteData } = usePageData();

  const { base } = siteData;

  return (
    <div>
      {notEmpty ? (
        postList.map((post) => {
          const { kinds, products } = post;
          const badges = [...kinds, ...products];
          const href= `${base}${post.route}`.replaceAll("//", "/")

          return (
            <LinkCard
              style={{ borderWidth: "0 0 1px 0 ", borderRadius: 0 }}
              title={post.title}
              description={
                <>
                  <div
                    className="line-clamp-2"
                    dangerouslySetInnerHTML={{
                      __html: Marked.parse(post.excerpt),
                    }}
                  ></div>

                  <div className="flex mt-2">
                    {badges.map((badge) => (
                      <div className="mr-2">
                        <Badge>{badge}</Badge>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between">
                    <LastUpdated></LastUpdated>
                    <DocID id={post.id}></DocID>
                  </div>
                </>
              }
              href={href.endsWith('.html')?href:`${href}.html`}
              key={post.route}
            ></LinkCard>
          );
        })
      ) : (
        <EmptyState></EmptyState>
      )}
    </div>
  );
};
