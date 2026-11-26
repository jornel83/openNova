/** Synthetic text only; this corpus contains no user conversations or project documents. */
export const PROJECTS=[
  {id:'project-a',name:'OpenNova',goal:'开发自然交流的个人助手',status:'active'},
  {id:'project-b',name:'内容创作',goal:'制作摄影教学视频',status:'active'},
  {id:'project-old',name:'旧网站',goal:'旧版网站',status:'archived'},
];
const work={focus:'work',projectId:'project-a',resumableProjectId:'project-a'};
const daily={...work,focus:'daily'};
const growth=[...PROJECTS,{id:'growth-one',name:'增长',goal:'国内业务',status:'active'},{id:'growth-two',name:'增长',goal:'海外业务',status:'active'}];
const expected=(focus,projectId=null)=>({focus,projectId});
const make=(id,text,target,extra={})=>({id,text,expected:target,projects:PROJECTS,context:work,recent:[],...extra});
export const ROUTING_CASES=[
  make('daily-food','今晚有点想吃面，想聊聊家常做法。',expected('daily')),
  make('daily-fatigue','今天好累，先陪我聊点轻松的吧。',expected('daily')),
  make('work-emotion','工作真的把我弄得很烦，只想吐槽一下，今天不处理项目。',expected('daily')),
  make('explicit-daily','先不聊工作了，我想说说最近的生活。',expected('daily')),
  make('daily-pronoun','他后来呢？',expected('daily'),{context:daily,recent:[{role:'user',text:'我朋友上周去领养了一只小狗。'},{role:'assistant',text:'后来朋友带小狗回了家，正在慢慢适应。'}]}),
  make('daily-continuation','接着说刚才那只小狗的故事。',expected('daily'),{context:daily,recent:[{role:'user',text:'聊聊我朋友和小狗的事。'}]}),
  make('resume-named','我们回到 OpenNova，接着做项目上下文功能。',expected('work','project-a'),{context:daily}),
  make('resume-plan','刚才那个方案第二点，再解释一下。',expected('work','project-a'),{context:daily,recent:[{role:'user',text:'OpenNova 的实现方案先分三点讲。'},{role:'assistant',text:'第二点是将项目会话和日常会话分别保存。'},{role:'user',text:'我去倒杯水。'}]}),
  make('continue-current','继续完善这个项目的开发计划。',expected('work','project-a')),
  make('switch-named','看看内容创作项目的摄影课脚本。',expected('work','project-b')),
  make('mixed-intent','今天真累，不过 OpenNova 的后台测试还是继续跑，别停。',expected('work','project-a')),
  make('quote-not-mode','OpenNova 的方案里写了“先不聊工作”，这句话要不要删掉？',expected('work','project-a')),
  make('quote-other-project','文档里引用了“切换到内容创作项目”这句话，但本轮只修改 OpenNova 的按钮文案。',expected('work','project-a')),
  make('ambiguous-name','继续增长项目。',expected('clarify'),{projects:[...PROJECTS,{id:'growth-one',name:'增长',goal:'国内业务',status:'active'},{id:'growth-two',name:'增长',goal:'海外业务',status:'active'}]}),
  make('archived-target','去旧网站项目修改首页。',expected('clarify')),
  make('unknown-target','切到火星基地项目继续建设。',expected('clarify')),
  make('multiple-targets','同时修改 OpenNova 的实现和内容创作的脚本，两个项目都现在开始。',expected('clarify')),
  make('task-owner','请继续任务 task-beta-1。',expected('work','project-b'),{context:{...work,tasks:[{id:'task-beta-1',projectId:'project-b',title:'修改摄影课脚本',status:'paused'}]}}),
  make('background-mention','后台任务照常运行就好，不用查看它。我现在想聊周末去哪里散步。',expected('daily')),
  make('clarification-answer','我说的是内容创作项目。',expected('work','project-b'),{recent:[{role:'user',text:'接着那个项目。'},{role:'assistant',text:'你希望继续哪个项目？'}]}),
  make('restore-archived','请先恢复已归档的旧网站项目，暂时不用改文件。',{focus:'manage',projectId:'project-old',action:'restore'}),
  make('create-project','帮我创建一个名叫旅行相册的新项目，目标是整理出游照片。',expected('work','project-a'),{context:daily}),
  make('negated-switch','不要切到内容创作，继续当前 OpenNova 的方案。',expected('work','project-a')),
  make('hypothetical-switch','如果以后切到内容创作会怎样？现在继续 OpenNova 的方案。',expected('work','project-a')),
  make('corrected-target','不是 OpenNova，我说的是内容创作，继续摄影课脚本。',expected('work','project-b')),
  make('short-project-answer','内容创作',expected('work','project-b'),{recent:[{role:'user',text:'接着那个项目。'},{role:'assistant',text:'你要继续 OpenNova 还是内容创作？'}]}),
  make('same-name-domestic','切到增长项目的国内业务，继续讨论方案。',expected('work','growth-one'),{projects:growth}),
  make('same-name-overseas','切到增长项目的海外业务，继续讨论方案。',expected('work','growth-two'),{projects:growth}),
  make('same-name-correction','不要国内业务，改为增长项目的海外业务。',expected('work','growth-two'),{projects:growth,context:{focus:'work',projectId:'growth-one',resumableProjectId:'growth-one'}}),
  make('same-name-goal-answer','海外',expected('work','growth-two'),{projects:growth,recent:[{role:'user',text:'继续增长项目。'},{role:'assistant',text:'有两个增长项目，你要继续国内业务还是海外业务？'}]}),
  make('same-name-quoted-goal','资料里引用了“增长项目的海外业务”，但本轮只修改 OpenNova 的按钮文案。',expected('work','project-a'),{projects:growth}),
  make('same-name-ambiguous-goal','继续增长项目的业务。',expected('clarify'),{projects:growth}),
  make('resume-color-daily','回到验收-甲，刚才确定的页面主色是什么？',expected('work','project-a'),{projects:[{id:'project-a',name:'验收-甲',goal:'代码功能验收',status:'active'},PROJECTS[1]],context:daily}),
  make('resume-color-work','回到验收-甲，刚才确定的页面主色是什么？',expected('work','project-a'),{projects:[{id:'project-a',name:'验收-甲',goal:'代码功能验收',status:'active'},PROJECTS[1]]}),
];
