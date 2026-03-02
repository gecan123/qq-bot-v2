import { Header } from "@/components/layout/header";
import { MediaGrid } from "@/components/media/media-grid";
import { Badge } from "@/components/ui/badge";
import { getMediaList } from "@/lib/queries";

interface Props {
  searchParams: Promise<{ page?: string }>;
}

const PAGE_SIZE = 48;

export default async function MediaPage({ searchParams }: Props) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10));

  const { items, total } = await getMediaList(page, PAGE_SIZE);

  return (
    <>
      <Header
        title="媒体库"
        description="所有群组的图片与文件"
        actions={
          <Badge variant="secondary" className="bg-slate-100 text-slate-500 border-slate-200">
            共 {total.toLocaleString("zh-CN")} 个文件
          </Badge>
        }
      />
      <MediaGrid items={items} total={total} page={page} pageSize={PAGE_SIZE} />
    </>
  );
}
