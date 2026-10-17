/**
 * ZTools Pinyin, Polyphone & Acronym Helper
 *
 * 轻量化零外部依赖的中文全拼、多音字与拼音首字母提取及高亮区间映射引擎。
 * 覆盖桌面效率工具、系统设置、文件管理、开发运维与办公全场景高频汉字与多音字。
 */

const BOUNDARIES: Array<[string, string]> = [
  ['a', '啊'], ['b', '芭'], ['c', '擦'], ['d', '搭'], ['e', '蛾'], ['f', '发'], ['g', '噶'],
  ['h', '哈'], ['j', '击'], ['k', '喀'], ['l', '垃'], ['m', '妈'], ['n', '拿'], ['o', '哦'],
  ['p', '趴'], ['q', '期'], ['r', '然'], ['s', '撒'], ['t', '塌'], ['w', '挖'], ['x', '昔'],
  ['y', '压'], ['z', '匝']
]

/**
 * 常用汉字标准全拼映射表（按拼音归组，紧凑高效）
 */
const PINYIN_GROUP_DICT: Record<string, string> = {
  a: '啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘按暗岸胺案肮昂盎凹熬敖翱袄傲奥懊澳',
  ai: '埃挨哎唉哀皑癌蔼矮艾碍爱隘',
  an: '鞍氨安俺按暗岸胺案',
  ang: '肮昂盎',
  ao: '凹熬敖翱袄傲奥懊澳',
  ba: '芭捌扒叭吧笆八疤巴拔跋靶把耙坝霸罢爸',
  bai: '白柏百摆佰败拜稗',
  ban: '斑班搬扳般颁板版扮拌伴瓣半办绊',
  bang: '邦帮梆榜膀绑棒磅蚌镑傍谤',
  bao: '苞胞包褒剥薄雹保堡饱宝抱报暴豹鲍爆',
  bei: '杯碑悲卑北辈背贝钡倍狈备惫焙被',
  ben: '奔苯本笨崩绷甭泵蹦迸',
  bi: '逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必辟壁臂避陛哔',
  bian: '鞭边编贬扁便变卞辨辩辫遍',
  biao: '标彪膘表',
  bie: '鳖憋别瘪',
  bin: '彬斌濒滨宾摈',
  bing: '兵冰柄丙秉饼炳病并屏',
  bo: '玻菠播拨钵波博勃搏铂箔伯帛舶脖膊渤泊驳捕卜',
  bu: '哺补埠不布步簿部怖',
  ca: '擦',
  cai: '猜裁材才财睬踩采彩菜蔡',
  can: '餐参蚕残惭惨灿',
  cang: '苍舱仓沧藏',
  cao: '操糙槽曹草',
  ce: '厕策侧册测',
  ceng: '层蹭',
  cha: '插叉茬茶查碴搽察岔差诧',
  chai: '拆柴豺',
  chan: '搀掺蝉馋谗缠铲产阐颤',
  chang: '昌猖场尝常长偿肠厂敞畅唱倡',
  chao: '超抄钞朝嘲潮巢吵炒',
  che: '车扯撤掣彻澈',
  chen: '郴臣辰尘晨忱沉陈趁衬',
  cheng: '撑称城橙成呈乘程惩澄诚承逞骋秤盛',
  chi: '吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽',
  chong: '充冲虫崇宠重',
  chou: '抽酬畴踌稠愁筹仇绸瞅丑臭',
  chu: '初出橱厨躇锄雏滁除楚础储矗搐触处',
  chuan: '揣川穿椽传船喘串',
  chuang: '疮窗幢床闯创',
  chui: '吹炊捶锤垂',
  chun: '春椿醇唇淳纯蠢',
  chuo: '戳绰',
  ci: '疵茨磁雌辞慈瓷词此刺赐次',
  cong: '聪葱囱匆从丛',
  cou: '凑',
  cu: '粗醋簇促',
  cuan: '蹿篡窜',
  cui: '摧崔催脆瘁粹淬翠',
  cun: '村存寸',
  cuo: '磋撮搓措挫错',
  da: '搭达答瘩打大',
  dai: '呆歹傣戴带殆代贷袋待逮怠',
  dan: '耽担丹单郸掸胆旦氮但惮淡诞弹蛋',
  dang: '当挡党荡档',
  dao: '刀捣蹈倒岛祷导到稻悼道盗',
  de: '德得的',
  deng: '蹬灯登等瞪凳邓',
  di: '堤低滴迪敌笛狄涤翟嫡抵底地蒂第帝弟递缔',
  dian: '颠掂滇碘点典靛垫电佃甸店惦奠淀殿',
  diao: '碉叼雕凋刁掉吊钓调',
  die: '跌爹碟蝶迭谍叠',
  ding: '丁盯叮钉顶鼎锭定订',
  diu: '丢',
  dong: '东冬董懂动栋侗恫冻洞',
  dou: '兜抖斗陡豆逗痘',
  du: '都督毒犊独读堵睹赌杜镀肚度渡妒',
  duan: '端短锻段断缎',
  dui: '堆兑队对',
  dun: '墩吨蹲敦顿囤钝盾遁',
  duo: '掇哆多夺垛躲朵跺舵剁惰堕',
  e: '蛾峨鹅俄额讹娥恶厄扼遏鄂饿',
  en: '恩',
  er: '而儿耳尔饵洱二贰',
  fa: '发罚筏伐乏阀法珐',
  fan: '藩帆番翻樊矾钒繁凡烦反返范贩犯饭泛',
  fang: '坊芳方肪房防妨仿访纺放',
  fei: '菲非啡飞肥匪诽吠肺废沸费',
  fen: '芬酚吩氛分纷坟焚汾粉奋份忿愤粪',
  feng: '丰封枫蜂峰锋风疯烽逢冯缝讽奉凤',
  fo: '佛',
  fou: '否',
  fu: '夫敷肤孵扶拂辐幅氟符伏俘服浮涪福袱弗甫抚辅俯釜斧脯腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐',
  ga: '噶嘎',
  gai: '该改概钙盖溉',
  gan: '干甘杆柑竿肝赶感秆敢赣',
  gang: '冈刚钢缸肛纲岗港杠',
  gao: '篙皋高膏羔糕搞镐稿告',
  ge: '哥歌搁戈鸽胳疙割革葛格蛤阁隔铬个各',
  gei: '给',
  gen: '根跟',
  geng: '耕更庚羹埂耿梗',
  gong: '工攻功恭龚供躬公宫弓巩汞拱贡共',
  gou: '钩勾沟苟狗垢构购够',
  gu: '辜菇咕箍估沽孤姑鼓古蛊骨谷股故顾固雇',
  gua: '刮瓜剐寡挂褂',
  guai: '乖拐怪',
  guan: '棺关官冠观管馆罐惯灌贯',
  guang: '光广逛',
  gui: '瑰规圭硅归龟闺轨鬼诡癸桂柜跪贵刽',
  gun: '辊滚棍',
  guo: '锅郭国果裹过',
  ha: '哈',
  hai: '骸孩海氦亥害骇还',
  han: '酣憨邯韩含涵寒函喊罕翰撼捍旱憾悍焊汗汉',
  hang: '夯杭航行',
  hao: '壕嚎豪毫郝好耗号浩',
  he: '呵喝荷菏核禾和何合盒貉阂河涸赫褐鹤贺',
  hei: '嘿黑',
  hen: '痕很狠恨',
  heng: '哼亨横衡恒',
  hong: '轰哄烘虹鸿洪宏弘红',
  hou: '喉侯猴吼厚候后',
  hu: '呼乎忽瑚壶葫胡蝴狐糊湖弧虎唬护互沪户',
  hua: '花哗华猾滑画划化话',
  huai: '槐徊怀淮坏',
  huan: '欢环桓还缓换患唤痪豢焕涣宦幻',
  huang: '荒慌黄磺蝗簧皇凰惶煌晃幌恍谎',
  hui: '灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘',
  hun: '荤昏婚魂浑混',
  huo: '豁活伙火获或惑霍货祸',
  ji: '击圾基机畸稽积箕肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪系',
  jia: '嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁',
  jian: '歼监坚尖笺间煎兼肩艰奸缄茧检柬碱硷拣捡简俭剪减荐槛鉴践贱见键箭件健舰剑饯渐溅涧建',
  jiang: '僵姜将浆江疆蒋桨奖讲匠酱降',
  jiao: '蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖校',
  jie: '揭接皆秸街阶截劫节桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届',
  jin: '巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸尽劲',
  jing: '荆兢茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净',
  jiong: '炯窘',
  jiu: '揪究纠玖韭久灸九酒厩救旧臼舅咎就疚',
  ju: '鞠拘狙疽居驹菊局咀矩举沮聚拒据巨具距踞锯俱句惧炬剧',
  juan: '捐鹃娟倦眷卷绢',
  jue: '撅攫抉掘倔爵觉决诀绝角',
  jun: '均菌钧军君峻俊竣浚郡骏',
  ka: '喀咖卡咯',
  kai: '开揩楷凯慨',
  kan: '刊堪勘坎砍看',
  kang: '康慷糠扛抗亢炕',
  kao: '考拷烤靠',
  ke: '坷苛柯棵磕颗科壳咳可渴克刻客课',
  ken: '肯啃垦恳',
  keng: '坑吭',
  kong: '空恐孔控',
  kou: '抠口扣寇',
  ku: '枯哭窟苦酷库裤',
  kua: '夸垮挎跨胯',
  kuai: '块筷侩快',
  kuan: '宽款',
  kuang: '匡筐狂框矿眶旷况',
  kui: '亏盔岿窥葵奎魁傀馈愧溃',
  kun: '坤昆捆困',
  kuo: '括扩廓阔',
  la: '垃拉喇蜡腊辣啦',
  lai: '莱来赖',
  lan: '蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥',
  lang: '琅榔狼廊郎朗浪',
  lao: '捞劳牢老佬姥酪烙涝',
  le: '勒乐了',
  lei: '雷镭蕾磊累儡垒擂肋类泪',
  leng: '棱楞冷',
  li: '厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐痢立粒沥隶力璃哩',
  lian: '联莲连镰廉怜涟帘敛脸链恋炼练',
  liang: '粮凉梁粱良两辆量晾亮谅',
  liao: '撩聊僚疗燎寥辽潦了撂镣廖料',
  lie: '列裂烈劣猎',
  lin: '琳林磷霖临邻鳞淋凛赁吝拎',
  ling: '伶菱零龄铃伶羚凌灵陵岭领另令',
  liu: '溜琉榴硫馏留刘瘤流柳六',
  long: '龙聋咙笼窿隆垄拢陇',
  lou: '楼娄搂篓漏陋',
  lu: '芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录陆戮驴吕铝侣旅履屡缕虑氯律率滤绿',
  lv: '驴吕铝侣旅履屡缕虑氯律率滤绿',
  luan: '峦挛孪滦卵乱',
  lue: '掠略',
  lun: '抡轮伦仑沦纶论',
  luo: '萝螺罗逻锣箩骡裸落洛骆络',
  ma: '妈麻玛码蚂马骂嘛吗',
  mai: '埋买麦卖迈脉',
  man: '瞒馒蛮满蔓曼慢漫谩',
  mang: '芒茫盲氓忙莽',
  mao: '猫茅锚毛矛铆卯茂冒帽貌贸',
  me: '么',
  mei: '玫枚梅酶霉煤没眉媒镁每美昧寐妹媚',
  men: '门闷们',
  meng: '萌蒙檬盟锰猛梦孟',
  mi: '眯醚靡糜迷谜弥米秘觅泌蜜密幂',
  mian: '棉眠绵冕免勉娩缅面',
  miao: '苗描瞄藐秒渺庙妙',
  mie: '蔑灭',
  min: '民抿皿敏悯闽',
  ming: '明螟鸣铭名命',
  miu: '谬',
  mo: '摸摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌',
  mou: '谋牟某',
  mu: '拇牡亩姆母墓暮幕募慕木目睦牧穆',
  na: '拿哪呐钠那娜纳',
  nai: '氖乃奶耐奈',
  nan: '南男难',
  nang: '囊',
  nao: '挠脑恼闹淖',
  ne: '呢',
  nei: '馁内',
  nen: '嫩',
  neng: '能',
  ni: '妮霓倪泥尼拟你匿腻逆溺',
  nian: '蔫拈年碾撵捻念',
  niang: '娘酿',
  niao: '鸟尿',
  nie: '捏聂孽啮镊镍涅',
  nin: '您',
  ning: '柠狞凝宁拧泞',
  niu: '牛扭钮纽',
  nong: '脓浓农弄',
  nu: '奴努怒',
  nv: '女',
  nuan: '暖',
  nue: '虐疟',
  nuo: '挪懦糯诺',
  o: '哦欧鸥殴藕呕偶沤',
  ou: '欧鸥殴藕呕偶沤',
  pa: '啪趴爬帕怕琶',
  pai: '拍排牌徘湃派',
  pan: '攀潘盘磐盼畔判叛',
  pang: '乓庞旁耪胖',
  pao: '抛咆刨炮袍跑泡',
  pei: '呸胚培裴赔陪配佩沛',
  pen: '喷盆',
  peng: '砰抨烹澎彭蓬棚硼篷膨朋鹏捧碰坯',
  pi: '砒霹批披劈琵毗啤脾疲皮匹痞僻屁譬',
  pian: '篇偏片骗',
  piao: '飘漂瓢票',
  pie: '撇瞥',
  pin: '拼频贫品聘',
  ping: '乒坪苹萍平凭瓶评屏',
  po: '坡泼颇婆破魄迫粕剖扑铺仆莆葡菩蒲埔朴圃普浦谱曝瀑',
  pu: '扑铺仆莆葡菩蒲埔朴圃普浦谱曝瀑',
  qi: '期欺栖戚妻七凄漆柒沏其棋奇歧畦崎脐齐旗祈祁骑起岂乞企启契砌器气迄弃汽泣讫',
  qia: '掐恰洽',
  qian: '牵扦钎铅千迁签仟谦乾黔钱钳前潜遣浅谴堑嵌欠歉',
  qiang: '枪呛腔羌墙蔷强抢',
  qiao: '橇锹敲悄桥瞧乔侨巧鞘撬翘峭俏窍',
  qie: '切茄且怯窃',
  qin: '钦侵亲秦琴勤芹擒禽寝沁',
  qing: '青轻氢倾卿清擎晴氰情顷请庆',
  qiong: '琼穷',
  qiu: '秋丘邱球求囚酋泅',
  qu: '趋区蛆曲躯屈驱渠取娶龋趣去',
  quan: '圈颧权醛泉全痊拳犬券劝',
  que: '缺炔瘸却鹊榷确雀',
  qun: '裙群',
  ran: '然燃冉染',
  rang: '瓤壤攘嚷让',
  rao: '饶扰绕',
  re: '惹热',
  ren: '壬仁人忍韧任认刃妊纫',
  reng: '扔仍',
  ri: '日',
  rong: '戎茸蓉荣融熔溶容绒冗',
  rou: '揉柔肉',
  ru: '茹蠕儒孺如辱乳汝入褥',
  ruan: '软阮',
  rui: '蕊瑞锐',
  run: '闰润',
  ruo: '若弱',
  sa: '撒洒萨',
  sai: '腮鳃塞赛',
  san: '三叁伞散',
  sang: '桑嗓丧',
  sao: '搔骚扫嫂',
  se: '瑟色涩',
  sen: '森',
  seng: '僧',
  sha: '莎砂杀刹沙纱傻啥煞',
  shai: '筛晒',
  shan: '珊苫杉山删煽衫闪陕擅赡膳善汕扇缮',
  shang: '墒伤商赏晌上尚裳',
  shao: '梢捎稍烧芍勺韶少哨邵绍',
  she: '奢赊蛇舌舍赦摄射慑涉社设',
  shen: '砷申呻伸身深娠绅神沈审婶甚肾慎渗',
  sheng: '声生甥牲升绳省盛剩胜圣',
  shi: '师失狮施湿诗尸虱十石拾时什食蚀实识史矢使屎驶始式示士世柿事拭誓逝势是嗜噬适仕侍释饰氏市恃室视试',
  shou: '收手首守寿授售受瘦兽',
  shu: '蔬枢梳殊抒输叔舒淑疏书赎孰熟薯暑曙署蜀黍鼠属术述树束戍竖墅庶数漱恕',
  shua: '刷耍',
  shuai: '摔衰甩帅',
  shuan: '栓拴',
  shuang: '霜双爽',
  shui: '谁水睡税',
  shun: '吮瞬顺舜',
  shuo: '说硕朔烁',
  si: '斯撕嘶思私司丝死肆寺嗣四伺似饲巳',
  song: '松耸怂颂送宋讼诵',
  sou: '搜艘擞嗽',
  su: '苏酥俗素速粟僳塑溯宿诉肃',
  suan: '酸蒜算',
  sui: '虽隋随绥髓碎岁穗遂隧祟',
  sun: '孙损笋',
  suo: '蓑梭唆缩琐索锁所',
  ta: '塌他它她塔獭挞蹋踏',
  tai: '胎苔抬台泰酞太态汰',
  tan: '坍摊贪瘫滩坛檀痰潭谭谈坦毯袒碳探叹炭',
  tang: '汤塘搪堂棠膛唐糖倘躺淌趟烫',
  tao: '掏涛滔绦萄桃逃淘陶讨套',
  te: '特',
  teng: '藤腾疼誊',
  ti: '梯剔踢锑提题蹄啼体替嚏惕涕剃屉',
  tian: '天添填田甜恬舔腆',
  tiao: '挑条迢眺跳调',
  tie: '贴铁帖',
  ting: '厅听烃汀廷停亭庭挺艇',
  tong: '通桐酮瞳同铜彤童桶捅筒统痛',
  tou: '偷投头透',
  tu: '凸秃突图徒途涂屠土吐兔',
  tuan: '湍团',
  tui: '推颓腿蜕褪退',
  tun: '吞屯臀',
  tuo: '拖托脱鸵陀驮驼椭妥拓唾',
  wa: '挖哇蛙洼娃瓦袜',
  wai: '歪外',
  wan: '豌弯湾玩顽丸烷完碗挽晚皖惋宛婉万腕',
  wang: '汪王亡枉网往旺望忘妄',
  wei: '威巍微危韦违桅围唯惟为潍维苇萎委伟伪尾纬未蔚味畏胃喂魏位渭谓尉慰卫',
  wen: '瘟温蚊文闻纹吻稳紊问',
  weng: '嗡翁瓮',
  wo: '挝蜗涡窝我斡卧握沃',
  wu: '巫呜钨乌污诬屋无芜梧吾吴毋武五捂午舞伍侮坞戊雾晤物勿务悟误',
  xi: '昔熙析西硒矽晰嘻吸锡牺稀息希悉膝夕惜熄烯溪汐犀檄袭席习媳喜铣洗系隙戏细',
  xia: '瞎虾匣霞辖暇峡侠狭下厦夏吓',
  xian: '掀锨先仙鲜纤咸贤衔舷闲涎弦嫌显险现献县腺馅羡宪陷限线',
  xiang: '相厢镶香箱襄湘乡翔祥详想响享项巷橡像向象',
  xiao: '萧硝霄削哮嚣销消宵淆晓小孝校肖啸笑效',
  xie: '楔些歇蝎鞋协挟携邪斜胁谐写械卸蟹懈泄泻谢屑',
  xin: '薪芯锌欣辛新忻心信衅',
  xing: '星腥猩惺兴刑型形邢行醒幸杏性姓',
  xiong: '兄凶胸匈汹雄熊',
  xiu: '休修羞朽嗅锈秀袖绣',
  xu: '墟戌需虚嘘须徐许蓄酗叙旭序畜恤絮婿绪续',
  xuan: '轩喧宣悬旋玄选癣眩绚',
  xue: '靴薛学穴雪血',
  xun: '勋熏循旬询寻驯巡殉汛训讯逊迅',
  ya: '压押鸦鸭呀丫芽牙蚜崖衙涯雅哑亚讶',
  yan: '焉咽阉烟淹盐严研蜒岩延言颜阎炎沿奄掩眼衍演艳堰燕厌砚雁唁彦焰宴谚验',
  yang: '殃央鸯秧杨扬佯疡羊洋阳氧仰痒养样漾',
  yao: '邀腰妖瑶摇尧遥窑谣姚咬舀药要耀钥',
  ye: '椰噎耶爷野冶也页掖业叶曳腋夜液',
  yi: '一壹医揖铱依伊衣颐夷遗移仪胰疑沂宜姨彝椅蚁倚已乙矣以艺抑易邑屹亿役臆逸肄疫亦裔意毅忆义益溢诣议谊译异翼翌绎',
  yin: '茵荫因殷音阴姻吟银淫寅饮尹引隐印',
  ying: '英樱婴鹰应缨莹萤营荧蝇迎赢盈影颖硬映',
  yo: '哟',
  yong: '拥佣臃痈庸雍踊蛹咏泳涌永恿勇用',
  you: '幽优悠忧尤由邮铀犹油游酉有友右佑釉诱又幼',
  yu: '迂淤于盂榆虞愚舆余俞逾鱼愉渝渔隅予娱雨与屿禹宇语羽玉域芋郁吁遇喻峪御愈欲狱育誉浴寓裕预豫驭',
  yuan: '鸳渊冤元垣袁原援辕园员圆猿源缘远苑愿怨院',
  yue: '曰约越跃钥岳粤月悦阅乐',
  yun: '耘云郧匀陨允运蕴酝晕韵孕',
  za: '匝砸杂',
  zai: '栽哉灾宰载再在咱',
  zan: '攒暂赞',
  zang: '赃脏葬',
  zao: '遭糟凿藻枣早澡蚤躁噪造皂灶燥',
  ze: '责择则泽',
  zei: '贼',
  zen: '怎',
  zeng: '增憎曾赠',
  zha: '扎喳渣札轧铡闸眨栅榨咋乍炸诈',
  zhai: '摘斋宅窄债寨',
  zhan: '瞻毡詹粘沾盏斩辗崭展蘸栈占战站湛绽',
  zhang: '樟章彰漳张掌涨杖丈帐账仗胀瘴障长',
  zhao: '招昭找沼赵照罩兆肇召',
  zhe: '遮折哲蛰辙者锗蔗这浙',
  zhen: '珍斟真甄砧臻贞针侦枕疹诊震振镇阵蒸',
  zheng: '蒸挣睁征狰争怔整拯正政帧症郑证',
  zhi: '芝枝支吱蜘知肢脂汁之织职直植殖执值侄址指止趾只旨纸志挚掷至致置帜峙制智秩稚质炙痔滞治窒',
  zhong: '中盅忠钟衷终种肿重仲众',
  zhou: '舟周州洲诌粥轴肘帚咒皱宙昼骤',
  zhu: '珠株蛛朱猪诸诛逐竹烛煮拄瞩嘱主著柱助蛀贮铸筑住注祝驻属',
  zhua: '抓爪',
  zhuai: '拽',
  zhuan: '专砖转撰赚篆传',
  zhuang: '桩庄装妆撞壮状',
  zhui: '椎锥追赘坠缀',
  zhun: '谆准',
  zhuo: '捉拙卓桌琢茁酌啄着灼浊',
  zi: '兹咨资姿滋淄孜紫仔籽滓子自渍字',
  zong: '鬃棕踪宗综总纵',
  zou: '邹走奏揍',
  zu: '租足卒族祖诅阻组',
  zuan: '钻纂',
  zui: '嘴醉最罪',
  zun: '尊遵',
  zuo: '昨左佐柞做作坐座'
}

/**
 * 常见多音字映射（确保不同读音词组如“重命名/重要”、“还原/还有”、“调色板/调度”、“音乐/快乐”均能命中）
 */
const POLYPHONE_MAP: Record<string, string[]> = {
  '重': ['chong', 'zhong'],
  '还': ['huan', 'hai'],
  '调': ['tiao', 'diao'],
  '行': ['xing', 'hang'],
  '乐': ['yue', 'le'],
  '长': ['chang', 'zhang'],
  '传': ['chuan', 'zhuan'],
  '数': ['shu', 'shuo'],
  '弹': ['tan', 'dan'],
  '系': ['xi', 'ji'],
  '模': ['mo', 'mu'],
  '率': ['lv', 'lu', 'shuai'],
  '单': ['dan', 'shan'],
  '解': ['jie', 'xie'],
  '降': ['jiang', 'xiang'],
  '藏': ['cang', 'zang'],
  '盛': ['sheng', 'cheng'],
  '度': ['du', 'duo'],
  '省': ['sheng', 'xing'],
  '角': ['jiao', 'jue'],
  '校': ['xiao', 'jiao'],
  '参': ['can', 'shen'],
  '差': ['cha', 'chai', 'ci'],
  '恶': ['e', 'wu'],
  '折': ['zhe', 'she'],
  '宿': ['su', 'xiu'],
  '屏': ['ping', 'bing'],
  '属': ['shu', 'zhu'],
  '钥': ['yao', 'yue'],
  '便': ['bian', 'pian'],
  '的': ['de', 'di'],
  '了': ['le', 'liao']
}

// 构建单字 -> 拼音列表的快速查询表
const CHAR_PINYIN_LIST_MAP = new Map<string, string[]>()

function ensurePinyinLookupInitialized(): void {
  if (CHAR_PINYIN_LIST_MAP.size > 0) return

  for (const [py, chars] of Object.entries(PINYIN_GROUP_DICT)) {
    for (const ch of chars) {
      const existing = CHAR_PINYIN_LIST_MAP.get(ch)
      if (!existing) {
        CHAR_PINYIN_LIST_MAP.set(ch, [py])
      } else if (!existing.includes(py)) {
        existing.push(py)
      }
    }
  }

  for (const [ch, pys] of Object.entries(POLYPHONE_MAP)) {
    const existing = CHAR_PINYIN_LIST_MAP.get(ch) || []
    const merged = [...pys]
    for (const item of existing) {
      if (!merged.includes(item)) merged.push(item)
    }
    CHAR_PINYIN_LIST_MAP.set(ch, merged)
  }
}

/**
 * 获取单个汉字的所有可能全拼读音（支持多音字）
 */
export function getCharPinyins(char: string): string[] {
  if (!char) return []
  if (/^[a-zA-Z0-9]$/.test(char)) return [char.toLowerCase()]
  ensurePinyinLookupInitialized()

  const list = CHAR_PINYIN_LIST_MAP.get(char)
  if (list && list.length > 0) return list

  if (/^[\u4e00-\u9fa5]$/.test(char)) {
    for (let i = BOUNDARIES.length - 1; i >= 0; i--) {
      const b = BOUNDARIES[i]!
      if (char.localeCompare(b[1], 'zh-CN') >= 0) {
        return [b[0]]
      }
    }
  }
  return []
}

/**
 * 获取单个汉字的拼音首字母
 */
export function getCharInitial(char: string): string {
  const pinyins = getCharPinyins(char)
  if (pinyins.length > 0 && pinyins[0]) {
    return pinyins[0][0] || ''
  }
  return ''
}

/**
 * 获取单个字符的主全拼
 */
export function getCharPinyin(char: string): string {
  const pinyins = getCharPinyins(char)
  return pinyins[0] || ''
}

/**
 * 提取文本的全拼与首字母缩写（同时附加多音字组合以供快速索引）
 */
export function extractPinyinAndAcronym(text: string): { pinyin: string; acronym: string } {
  if (!text || typeof text !== 'string') {
    return { pinyin: '', acronym: '' }
  }

  const hasChinese = /[\u4e00-\u9fa5]/.test(text)
  let primaryPinyin = ''
  let primaryAcronym = ''
  let altPinyin = ''
  let altAcronym = ''
  let hasPolyphone = false

  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      const pys = getCharPinyins(char)
      const firstPy = pys[0] || ''
      const secondPy = pys[1] || firstPy
      if (pys.length > 1) hasPolyphone = true

      primaryPinyin += firstPy
      primaryAcronym += firstPy[0] || ''
      altPinyin += secondPy
      altAcronym += secondPy[0] || ''
    } else if (/[a-zA-Z0-9]/.test(char)) {
      const lower = char.toLowerCase()
      primaryPinyin += lower
      altPinyin += lower
      if (!hasChinese) {
        primaryAcronym += lower
        altAcronym += lower
      }
    }
  }

  return {
    pinyin: hasPolyphone && altPinyin !== primaryPinyin ? `${primaryPinyin} ${altPinyin}` : primaryPinyin,
    acronym: hasPolyphone && altAcronym !== primaryAcronym ? `${primaryAcronym} ${altAcronym}` : primaryAcronym
  }
}

/**
 * 在目标文本中匹配查询词（支持字面、全拼、首字母、多音字混排），返回命中的字符起止区间 [start, end)
 */
export function findPinyinMatchRange(text: string, query: string): [number, number] | null {
  if (!text || !query) return null
  const q = query.trim().toLowerCase()
  if (!q) return null

  const lowerText = text.toLowerCase()
  const literalIdx = lowerText.indexOf(q)
  if (literalIdx !== -1) {
    return [literalIdx, literalIdx + q.length]
  }

  // 仅当查询词为纯字母数字时尝试拼音匹配
  if (!/^[a-z0-9]+$/.test(q)) return null

  const chars = Array.from(text)
  const charTokens = chars.map((ch) => {
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      return getCharPinyins(ch)
    }
    if (/[a-zA-Z0-9]/.test(ch)) {
      return [ch.toLowerCase()]
    }
    return []
  })

  // 深度优先匹配从 startIdx 开始能否消费完整个 q
  function matchFrom(charIdx: number, qPos: number): number | null {
    if (qPos >= q.length) return charIdx
    if (charIdx >= charTokens.length) return null

    const tokens = charTokens[charIdx]!
    if (tokens.length === 0) return null

    for (const py of tokens) {
      if (!py) continue
      // 1. 首字母匹配 (消费 1 个查询字符)
      if (py[0] === q[qPos]) {
        const res = matchFrom(charIdx + 1, qPos + 1)
        if (res !== null) return res
      }
      // 2. 全拼匹配或末尾汉字前缀匹配
      const remainingQ = q.slice(qPos)
      if (remainingQ.startsWith(py)) {
        const res = matchFrom(charIdx + 1, qPos + py.length)
        if (res !== null) return res
      } else if (py.startsWith(remainingQ)) {
        // 查询词余下部分刚好是当前汉字拼音的前缀（完成匹配）
        return charIdx + 1
      }
    }
    return null
  }

  for (let i = 0; i < chars.length; i++) {
    if (charTokens[i]!.length === 0) continue
    const endCharIdx = matchFrom(i, 0)
    if (endCharIdx !== null) {
      const startCodeUnit = chars.slice(0, i).join('').length
      const endCodeUnit = chars.slice(0, endCharIdx).join('').length
      return [startCodeUnit, endCodeUnit]
    }
  }

  return null
}

/**
 * 拼音与文本多维度匹配判断
 */
export function matchesQuery(
  targets: Array<string | undefined | null>,
  query: string
): boolean {
  if (!query || !query.trim()) return true
  const q = query.trim().toLowerCase()

  for (const target of targets) {
    if (!target) continue
    if (findPinyinMatchRange(target, q) !== null) return true
    const { pinyin, acronym } = extractPinyinAndAcronym(target)
    if (pinyin.includes(q) || acronym.includes(q)) return true
  }

  return false
}
