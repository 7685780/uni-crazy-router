import {afterEachFn, beforeEachFn, onErrorFn, routerStatus} from "./storage"
import url from "url"

// 环境判断 用于app端的特殊处理
const env = process.env.VUE_APP_PLATFORM

// 内部防抖开关
let waitJumpSucc = false

/**
 * 注销绑定的函数
 * @param fnList 函数队列
 * @param fn 要注销的函数指针
 */
export function removeFn (fnList, fn) {
    const fnIndex = fnList.indexOf(fn)
    fnList.splice(fnIndex,1)
}

/**
 * 运行带有拦截功能的函数队列，支持async拦截
 * @param fnList 函数队列
 * @param to
 * @param from
 * @returns {Promise<boolean>}
 */
export async function callWithNext (fnList, to, from) {
    let stop = true
    function next () {
        routerStatus.afterNotNext = null // 重置afterNotNext
        stop = false
    }
    for (let fn of fnList) {
        await fn(to, from, next)
        if (stop) {
            return false
        }
        stop = true
    }
    return true
}

/**
 * 运行没有拦截功能的函数队列
 * @param fnList
 * @param to
 * @param from
 */
export function callWithoutNext (fnList, to, from) {
    fnList.forEach((fn) => {
        fn(to, from)
    })
}

/**
 * 获取路由参数
 * @param paramsName {String} 路由参数对象类型
 * @returns {*}
 */
export function getParams (paramsName) {
    const params = routerStatus[paramsName]
    routerStatus[paramsName] = null
    return params
}

/**
 * 高阶函数，抽取路由参数
 * @param payload {Object} 路由动作的参数
 * @param paramsName {String} 路由参数对象类型
 * @returns {*}
 */
function extractParams (payload, paramsName) {
    if (typeof payload[paramsName] === 'object') {
        routerStatus[paramsName] = {
            ...payload[paramsName]
        }
    }
    return payload
}

/**
 * 运行afterNotNext函数
 */
function callAfterNotNext () {
    const afterNotNext = routerStatus.afterNotNext
    routerStatus.afterNotNext = null
    if (typeof afterNotNext === 'function'){
        afterNotNext()
    }
}

/**
 * 获取async返回类型的路由动作结果
 * @param result
 * @param to
 * @param from
 * @returns {Promise<*>}
 */
async function getAsyncResult (result, to, from, jumpType) {
    try {
        let newResult = await result
        if (newResult.length === 1) {
            // 失败时重置防抖
            routerStatus.allowAction = true
            callWithoutNext(onErrorFn, to, from)
        } else {
            // 对h5的reLaunch特殊处理
            if (jumpType === 'reLaunch' && getCurrentPages().length === 1 && getNowUrl() === to.url && env === 'h5') {
                watchAllowAction()
                return newResult
            }

            // 对navigateBack的特殊处理 或 app-plus
            if ((jumpType === 'navigateBack' && getCurrentPages().length === 1) || env === 'app-plus') {
                watchAllowAction()
                let page = getNowPage()
                if (!('$routeParams' in page)) {
                    page.$routeParams = getParams('routeParams')
                }
                page.$passedParams = getParams('passedParams')
                if (page.$vm) {
                    page.$vm.$passedParams = page.$passedParams
                    if (!('$routeParams' in page.$vm)) {
                        page.$vm.$routeParams = getParams('routeParams')
                    }
                }

                // 执行afterEach
                callWithoutNext(afterEachFn, to, from)
                routerStatus.current = getNowRoute()
            }
        }
        return newResult
    } catch(e) {
        return new Error(e)
    }
}

/**
 * 添加路由链的标签
 * @param url
 * @returns {string}
 */
// function addRouteTag (url = '') {
//     routerStatus.routeTag = Math.random().toString(36).substr(2)
//     return url.replace(/[?$]/,'?_ucr' + routerStatus.routeTag + '&')
// }

/**
 * 对参数对象进行decode解析
 * @param paramsMap
 * @returns {{}}
 */
function decodeParamsMap (paramsMap) {
    let cloneMap = {...paramsMap}
    Object.keys(cloneMap).forEach((key) => {
        cloneMap[key] = decodeURIComponent(cloneMap[key])
    })
    return cloneMap
}

/**
 * 对参数对象进行encode处理，并且拼接字符串
 * @param paramsMap
 * @returns {string}
 */
function encodeParamsMapToString (paramsMap) {
    const resultArr = []
    Object.keys(paramsMap).forEach((key) => {
        resultArr.push(`${key}=${encodeURIComponent(paramsMap[key])}`)
    })
    return resultArr.join('&')
}

/**
 * 获取page对象的原生url参数
 * @param page
 * @returns {*}
 */
function getPageOptions (page) {
    if (!page) return
    // h5的page对象里没有options
    if (env === 'h5') {
        // 通过$mp.query获取
        return page.$mp.query
    }
    return page.options
}

/**
 * 原生路由动作的公共劫持方法
 * @param nativeFun {Function} 原生方法
 * @param payload {Object} 参数
 * @param jumpType {String} 原生方法名
 * @returns {*}
 */
export function intercept (nativeFun, payload={}, jumpType) {
    // 判断是否能获取到页面栈
    try {
        getNowUrl()
    } catch(e) {
        return nativeFun.call(uni, payload)
    }
    const appPlusNowRoute = getNowRoute()

    let {fail, success, complete} = payload
    // 防抖
    if (!routerStatus.allowAction) {
        let errMsg = '动作被拦截，因为已经有一个正在执行的路由动作'
        if (!(fail || success || complete)) {
            return [{errMsg}]
        }
        return payload.fail && payload.fail({errMsg})
    }
    routerStatus.allowAction = false
    waitJumpSucc = false
    let currentUrl = getNowUrl()
    let toUrl
    // 原始url参数
    let query = {}
    // 原始未经处理的query字符串
    let search = ''

    if (jumpType === 'navigateBack') {
        let {delta = 1} = payload
        let targetIndex = getCurrentPages().length - 1 - delta
        if (targetIndex < 0) {
            targetIndex = 0
        }
        // 记录返回参考信息，用于验证
        routerStatus.actionInfo.navigateBack = targetIndex
        toUrl = getCurrentPages()[targetIndex].route
        query = getPageOptions(getCurrentPages()[targetIndex])
        search = encodeParamsMapToString(query)
        // h5环境uni使用的是vue-router会自动decode
        if (env !== 'h5') {
            query = decodeParamsMap(query)
        }

    } else {
        // 去除根斜杠
        toUrl = url.resolve(currentUrl,payload.url||'').replace(/^\/([^\/])/,'$1')
        let tempMatch = toUrl.match(/([^?]+)\?([\s\S]*)/)
        // 去掉query参数
        toUrl = tempMatch && tempMatch[1] || toUrl
        // 将query参数存储到query对象
        if (tempMatch && tempMatch[2]) {
            search = tempMatch[2]
            tempMatch[2].split('&').forEach((paramString) => {
                if (!paramString) return
                let paramStringMatch = paramString.match(/^([^=]+)=([\s\S]*)$/)
                if (paramStringMatch && paramStringMatch[2]) {
                    query[paramStringMatch[1]] = paramStringMatch[2]
                    return
                }
                query[paramString] = ''
            })
        }
        query = decodeParamsMap(query)
    }

    if (jumpType === 'switchTab') {
        routerStatus.actionInfo.switchTab = toUrl
    }
    routerStatus.actionType = jumpType

    let to = {
        url: toUrl,
        routeParams: payload.routeParams,
        passedParams: payload.passedParams,
        query,
        jumpType,
        search
    }

    // 代表回调类型，返回undefined
    if (fail || success || complete) {
        payload.fail = (...params) => {
            // 失败时重置防抖
            routerStatus.allowAction = true
            callWithoutNext(onErrorFn, to, env === 'app-plus' ? appPlusNowRoute : routerStatus.current)
            if (fail) {
                return fail.apply(this, params)
            }
        }

        // 对h5的reLaunch特殊处理
        if (jumpType === 'reLaunch' && getCurrentPages().length === 1 && getNowUrl() === to.url && env === 'h5') {
            payload.success = (...params) => {
                watchAllowAction()
                if (success) {
                    return success.apply(this, params)
                }
            }
        }

        // 对navigateBack的特殊处理 或 app-plus
        if ((jumpType === 'navigateBack' && getCurrentPages().length === 1) || env === 'app-plus') {
            payload.success = (...params) => {
                watchAllowAction()
                let page = getNowPage()
                if (!('$routeParams' in page)) {
                    page.$routeParams = getParams('routeParams')
                }
                page.$passedParams = getParams('passedParams')
                if (page.$vm) {
                    page.$vm.$passedParams = page.$passedParams
                    if (!('$routeParams' in page.$vm)) {
                        page.$vm.$routeParams = getParams('routeParams')
                    }
                }
                // 执行afterEach
                callWithoutNext(afterEachFn, to, env === 'app-plus' ? appPlusNowRoute : routerStatus.current)
                routerStatus.current = getNowRoute()
                if (success) {
                    return success.apply(this, params)
                }
            }
        }

        // 自执行一个async函数
        (async function () {
            if (!await callWithNext(beforeEachFn, to, env === 'app-plus' ? appPlusNowRoute : routerStatus.current)) {
                payload.fail({
                    errMsg: 'beforeEach中没有使用next'
                })
                callAfterNotNext()
                return
            }
            waitJumpSucc = true
            nativeFun.call(uni, extractParams(extractParams(payload, 'routeParams'), 'passedParams'))
        })()
        return
    }

    // 返回async
    return (async function () {
        if (!await callWithNext(beforeEachFn, to, env === 'app-plus' ? appPlusNowRoute : routerStatus.current)) {
            // 失败时重置防抖
            routerStatus.allowAction = true
            callAfterNotNext()
            return [{
                errMsg:'beforeEach中没有使用next'
            }]
        }
        waitJumpSucc = true
        const result = nativeFun.call(uni, extractParams(extractParams(payload, 'routeParams'), 'passedParams'))
        return getAsyncResult (result, to, env === 'app-plus' ? appPlusNowRoute : routerStatus.current, jumpType)
    })()
}

/**
 * 获取当前的路由地址
 * @returns {(() => void) | string}
 */
function getNowUrl () {
    const pages = getCurrentPages()
    return pages[pages.length-1].route
}

/**
 * 获取当前的page对象
 * @returns {wx.Page | tinyapp.IPageInstance<any> | WechatMiniprogram.Page.Instance<IAnyObject, IAnyObject>}
 */
function getNowPage () {
    const pages = getCurrentPages()
    return pages[pages.length-1]
}

/**
 * 获取当前的路由原信息
 * @returns {{url: *, routeParams: (*|routerStatus.routerParams|{})}}
 */
function getNowRoute () {
    let nowPage = getNowPage()
    let query = getPageOptions(nowPage)
    // h5环境uni使用的是vue-router会自动decode
    if (env !== 'h5') {
        query = decodeParamsMap(query)
    }
    return {
        url: getNowUrl(),
        routeParams: nowPage.$routeParams,
        passedParams: nowPage.$passedParams,
        query,
        search: encodeParamsMapToString(query)
    }
}

/**
 * 监听防抖
 * @param succHook
 */
function watchAllowAction (succHook) {
    if (waitJumpSucc) {
        // 成功时重置防抖
        routerStatus.allowAction = true
        succHook && succHook()
    }
    waitJumpSucc = false
}

/**
 * 对路由进行包囊的公共方法
 * @param nativeFunName
 */
function wrapNativeFun (nativeFunName) {
    const nativeFun = uni[nativeFunName]
    uni[nativeFunName] = (payload) => {
        return intercept(nativeFun, payload, nativeFunName)
    }
}

/**
 * 对app的首页进行ready
 * @param readyHook
 */
function watchAppIndexReady (readyHook) {
    try {
        getNowPage()
        readyHook && readyHook()
    } catch(e) {
        setTimeout(() => {
            watchAppIndexReady(readyHook)
        },13)
    }
}

/**
 * 鉴定路由的真伪，用于过滤非主动触发api造成的路由变更（这种路由叫做伪路由），遇到伪路由，不解锁
 * @returns {boolean}
 */
// function checkRouteTag () {
//     let tag = getNowPage().options[routerStatus.routeTag]
//
//     // h5环境的page对象没有options，通过$mp.query获取
//     if (env === 'h5') {
//         tag = getNowPage().$mp.query[routerStatus.routeTag]
//     }
//
//     return !(tag == null)
// }

/**
 * 清除所有动作信息
 */
function clearActionInfo () {
    routerStatus.actionInfo = {}
}

// 可能发生的原生情况只有navigateBack和switchTab(先排除h5的情况)
const actionMap = {
    navigateBack () {
        if (routerStatus.actionInfo.navigateBack == null) {
            return false
        }
        if (getCurrentPages().length-1 <= routerStatus.actionInfo.navigateBack) {
            clearActionInfo()
            return true
        }
    },
    switchTab () {
        if (routerStatus.actionInfo.switchTab == null) {
            return false
        }
        if (getCurrentPages().length === 1 && getNowUrl() === routerStatus.actionInfo.switchTab) {
            clearActionInfo()
            return true
        }
    }
}

/**
 * 验证是否原生动作 (将在之后1.0.0版本使用)
 * @returns {*}
 */
function checkNativeAction () {
    return actionMap[routerStatus.actionType]()
}

/**
 * 启动函数，用于在Vue plugin中的install方法中执行
 * @param Vue
 * @param options
 */
export function bootstrap (Vue, options) {
    Vue.mixin({
        onLoad(){
            // app-plus另外实现
            if (env === 'app-plus') {
                return
            }

            // // 鉴定路由
            // if (!checkRouteTag()) {
            //     return
            // }
            // watchAllowAction()
            getNowPage().$routeParams = this.$routeParams = getParams('routeParams')
        },
        onShow () {
            const readyToAfterEach = () => {
                watchAllowAction(() => {
                    getNowPage().$passedParams = this.$passedParams = getParams('passedParams')
                })
                // 执行afterEach
                callWithoutNext(afterEachFn, getNowRoute(), routerStatus.current)
                routerStatus.current = getNowRoute()
            }
            // app-plus另外实现，因为uni的app端，vue.mixin不会混合所有页面
            if (env === 'app-plus') {
                // APP show
                if (getCurrentPages().length < 1) {
                    // 下一次宏任务就是第一个页面的onShow
                    watchAppIndexReady(readyToAfterEach)
                }
                return
            }
            // 判断是否能获取到页面栈
            try {
                getNowUrl()
            } catch(e) {
                return
            }
            // 过滤App.vue
            if (this.globalData) {
                return
            }
            readyToAfterEach()
        }
    })

    // 包装uni的原生方法
    wrapNativeFun('navigateTo')
    wrapNativeFun('redirectTo')
    wrapNativeFun('reLaunch')
    wrapNativeFun('switchTab')
    wrapNativeFun('navigateBack')
}
