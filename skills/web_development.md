# SK-007: 网页开发（Web Development）

## 触发条件
用户要求开发网页、写HTML/CSS/JS、搭建前端页面、修复前端样式问题、做响应式适配。

## 核心规则

### HTML
- 使用语义化标签（header/nav/main/section/article/footer），不用div堆砌
- 表单必须有关联的label，input设置type和autocomplete属性
- 图片必须有alt属性和loading="lazy"
- 外部链接target="_blank"必须加rel="noopener noreferrer"

### CSS
- 移动优先：基础样式针对手机，用媒体查询向上覆盖桌面端
- 关键断点：480px/768px/1024px/1440px
- 布局优先用Flexbox/Grid，避免float和绝对定位做主要布局
- 颜色变量统一管理，暗色模式用prefers-color-scheme或data-theme切换
- 禁止magic number：所有间距/尺寸必须来自设计系统变量

### JavaScript
- 禁止innerHTML直接插入用户输入，用textContent或DOMPurify
- 事件监听用addEventListener，不用onclick属性
- 定时器（setInterval/setTimeout）必须在不需时clear
- fetch请求必须有catch和超时处理
- 避免同步XHR和阻塞主线程的长循环

### 移动端适配
- viewport必须设置为width=device-width, initial-scale=1.0
- 触摸目标最小44×44px（iOS HIG标准）
- iOS Safari的100vh问题：用dvh或JS动态计算
- 输入框font-size≥16px防止iOS自动缩放
- 滚动区域加-webkit-overflow-scrolling: touch

### 性能
- 关键CSS内联在head，非关键CSS异步加载（media="print"切换）
- 首屏JS延迟加载（defer/async）
- 字体文件用font-display: swap防FOIT
- 大图用srcset多分辨率适配
- 动画尽量用transform/opacity触发GPU合成层

## 常见陷阱
- z-index层级混乱：建立z-index scale（dropdown:100, modal:200, toast:300）
- 盒模型混淆：全局设box-sizing: border-box
- Flex子元素不换行：加flex-wrap: wrap
- 绝对定位元素溢出：父元素加overflow: hidden
- 中文网页用英文字体优先顺序导致中文回退到serif

## 输出规范
- 页面内容全部中文（按钮、提示、标题、错误信息等）
- 完整可运行的HTML文件，CSS/JS内联或相对引用
- 移动端和桌面端均验证过关键交互
