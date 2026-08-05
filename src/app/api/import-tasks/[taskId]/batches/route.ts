import { NextResponse } from "next/server";
import { getImportTask, listTaskBatches } from "@/lib/server/async-import-storage";
export const runtime="nodejs";
export async function GET(_:Request,context:{params:Promise<{taskId:string}>}){const {taskId}=await context.params;if(!await getImportTask(taskId))return NextResponse.json({error:"任务不存在"},{status:404});return NextResponse.json(await listTaskBatches(taskId));}
