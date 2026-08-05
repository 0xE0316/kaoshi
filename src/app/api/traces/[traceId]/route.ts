import { NextResponse } from "next/server";
import { searchTrace } from "@/lib/server/async-import-storage";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{traceId:string}>}){const {traceId}=await context.params;const q=new URL(request.url).searchParams;return NextResponse.json(await searchTrace({traceId,taskId:q.get("task_id")??undefined,fileName:q.get("file_name")??undefined,batch:q.get("batch")?Number(q.get("batch")):undefined,rowFrom:q.get("row_from")?Number(q.get("row_from")):undefined,rowTo:q.get("row_to")?Number(q.get("row_to")):undefined,errorCode:q.get("error_code")??undefined}));}
