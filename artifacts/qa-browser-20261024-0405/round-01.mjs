const task = await taskSpace(17);
console.log({ spaceId: task.spaceId, pages: await task.pages() });
console.log(await task.page("p1").snapshot());
