import { NextResponse } from "next/server";
import { isImportBatchCreatedEvent } from "@/lib/async-import-types";
import { processImportBatch } from "@/lib/server/import-worker";
import { verifyQueueRequest } from "@/lib/server/import-queue";
export const runtime="nodejs";export const maxDuration=60;
export async function POST(request:Request){const body=await request.text();if(!await verifyQueueRequest(request,body))return NextResponse.json({error:"队列签名校验失败"},{status:401});let event:unknown;try{event=JSON.parse(body);}catch{return NextResponse.json({error:"事件格式错误"},{status:400});}if(!isImportBatchCreatedEvent(event))return NextResponse.json({error:"不支持的事件版本、类型或载荷"},{status:422});try{return NextResponse.json(await processImportBatch(event));}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Worker 失败"},{status:500});}}
