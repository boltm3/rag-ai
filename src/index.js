import { Hono } from 'hono'; // 导入 Hono 框架
import { cors } from 'hono/cors'; // 导入跨域支持
import { methodOverride } from 'hono/method-override'; // 导入方法重写支持

import notes from './notes.html'; // 导入 HTML 模板
import ui from './ui.html'; // 导入 HTML 模板
import write from './write.html'; // 导入 HTML 模板

const app = new Hono(); // 创建 Hono 应用实例
app.use(cors()); // 使用 CORS 中间件，允许跨域请求

// 获取所有笔记的 JSON 格式数据
app.get('/notes.json', async (c) => {
	const query = `SELECT * FROM notes`; // 查询所有笔记
	const { results } = await c.env.DATABASE.prepare(query).all(); // 从数据库获取笔记数据
	return c.json(results); // 返回 JSON 格式的笔记数据
});

// 显示笔记列表页面
app.get('/notes', async (c) => {
	return c.html(notes); // 返回笔记列表页面的 HTML 内容
});

// 使用方法重写中间件处理 /notes/:id 路由的 DELETE 请求
app.use('/notes/:id', methodOverride({ app }));

// 删除指定 ID 的笔记
app.delete('/notes/:id', async (c) => {
	const { id } = c.req.param(); // 获取请求中的笔记 ID
	const query = `DELETE FROM notes WHERE id = ?`; // 删除笔记的 SQL 查询
	await c.env.DATABASE.prepare(query).bind(id).run(); // 执行删除操作
	await c.env.VECTOR_INDEX.deleteByIds([id]); // 从向量索引中删除对应的向量
	return c.redirect('/notes'); // 删除后重定向到笔记列表页面
});

// 创建新的笔记
app.post('/notes', async (c) => {
	const { text } = await c.req.json(); // 获取请求体中的文本内容
	if (!text) c.throw(400, 'Missing text'); // 如果文本内容为空，抛出 400 错误

	// 将新笔记插入数据库
	const { results } = await c.env.DATABASE.prepare('INSERT INTO notes (text) VALUES (?) RETURNING *').bind(text).run();

	const record = results.length ? results[0] : null; // 获取插入的笔记记录

	if (!record) c.throw(500, 'Failed to create note'); // 如果没有成功插入笔记，抛出 500 错误

	// 生成笔记的向量嵌入
	const { data } = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
	const values = data[0]; // 获取生成的向量值

	if (!values) c.throw(500, 'Failed to generate vector embedding'); // 如果生成向量失败，抛出 500 错误

	const { id } = record; // 获取新插入笔记的 ID
	const inserted = await c.env.VECTOR_INDEX.upsert([
		// 将向量插入向量索引
		{
			id: id.toString(),
			values,
		},
	]);

	return c.json({ id, text, inserted }); // 返回笔记的 ID、文本内容以及向量插入结果
});

// 显示 UI 页面
app.get('/ui', async (c) => {
	return c.html(ui); // 返回 UI 页面 HTML 内容
});

// 显示写入笔记页面
app.get('/write', async (c) => {
	return c.html(write); // 返回写入笔记页面 HTML 内容
});

// 处理首页请求，基于查询的文本进行响应
app.get('/', async (c) => {
	const question = c.req.query('text') || 'What is the square root of 9?'; // 获取用户提问的文本，如果没有提供，则使用默认问题

// 获取问题的向量嵌入
const embeddings = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: question })
console.log("question:",question)
const vectors = embeddings.data[0] // 获取问题的向量值
console.log("Qembeddings:",embeddings)

// 使用向量查询相关的笔记
const vectorQuery = await c.env.VECTOR_INDEX.query(vectors, { topK: 5 }); // topK: 3 获取前三个匹配项
const vecIds = vectorQuery.matches.map(match => match.id) // 获取前三个最相关的笔记 IDs
console.log("vectorQuery:",vectorQuery)
console.log("vecIds:",vecIds)

let notes = []
if (vecIds.length > 0) {
  // 查询数据库获取与问题最相关的笔记内容
  // 将 vecIds 传递给查询语句
  const query = `SELECT * FROM notes WHERE id IN (${vecIds.join(",")})`
  const { results } = await c.env.DATABASE.prepare(query).all() // 去除 bind，直接插入 vecIds
  if (results) notes = results.map(vec => vec.text) // 获取相关笔记的文本内容
}

// 构建上下文消息
const contextMessage = notes.length
  ? `${notes.map(note => `. ${note}`).join("\n")}`
  : ""
console.log("contextMessage:",contextMessage)


	// 系统提示，帮助 AI 理解回答的上下文
	const systemPrompt = `You are a Bolt.m3 ai robot. Please answer concisely based on the content provided below:`;

	// 调用 AI 生成答案
	const { response: answer } = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		prompt: '',
		messages: [
			...(notes.length ? [{ role: 'system', content: systemPrompt }] : []),
			{ role: 'user', content: 'DOCUMENT:' + contextMessage },
			{ role: 'user', content: 'QUESTION:' + question },
			{
				role: 'user',
				content:
					'INSTRUCTIONS: Answer the users QUESTION using the DOCUMENT text above. Keep your answer ground in the facts of the DOCUMENT.  If the DOCUMENT doesn’t contain the facts to answer the QUESTION return {NONE}',
			},
		],
	});

	return c.text(answer); // 返回 AI 的回答
});

// 处理错误
app.onError((err, c) => {
	return c.text(err); // 返回错误信息
});

export default app; // 导出应用实例
