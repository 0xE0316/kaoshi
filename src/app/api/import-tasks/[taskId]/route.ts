import { NextResponse } from "next/server";
import { getImportTask } from "@/lib/server/async-import-storage";
export const runtime="nodejs";
export async function GET(_:Request,context:{params:Promise<{taskId:string}>}){const {taskId}=await context.params;const task=await getImportTask(taskId);return task?NextResponse.json(task):NextResponse.json({error:"任务不存在"},{status:404});}
