import { NextResponse } from "next/server";
import { getImportTask, listTaskErrors } from "@/lib/server/async-import-storage";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{taskId:string}>}){const {taskId}=await context.params;if(!await getImportTask(taskId))return NextResponse.json({error:"任务不存在"},{status:404});const q=new URL(request.url).searchParams;return NextResponse.json(await listTaskErrors(taskId,{batch:q.get("batch")?Number(q.get("batch")):undefined,errorCode:q.get("error_code")??undefined,page:Math.max(1,Number(q.get("page")??1)),pageSize:Math.min(100,Math.max(1,Number(q.get("page_size")??50)))}));}
