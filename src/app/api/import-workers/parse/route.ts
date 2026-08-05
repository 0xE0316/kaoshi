import { NextResponse } from "next/server";
import { isImportTaskCreatedEvent } from "@/lib/async-import-types";
import { processImportFile } from "@/lib/server/import-worker";
import { dispatchOutbox, verifyQueueRequest } from "@/lib/server/import-queue";
export const runtime="nodejs";export const maxDuration=60;
export async function POST(request:Request){const body=await request.text();if(!await verifyQueueRequest(request,body))return NextResponse.json({error:"队列签名校验失败"},{status:401});let event:unknown;try{event=JSON.parse(body);}catch{return NextResponse.json({error:"事件格式错误"},{status:400});}if(!isImportTaskCreatedEvent(event))return NextResponse.json({error:"不支持的事件版本、类型或载荷"},{status:422});try{const result=await processImportFile(event);const dispatched=await dispatchOutbox(new URL(request.url).origin,50);return NextResponse.json({result,dispatched});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"解析 Worker 失败"},{status:500});}}
