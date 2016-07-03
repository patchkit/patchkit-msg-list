import pull from 'pull-stream'
import moment from 'moment'
import React from 'react'
import ReactCSSTransitionGroup from 'react-addons-css-transition-group'
import schemas from 'ssb-msg-schemas'
import mlib from 'ssb-msgs'
import threadlib from 'patchwork-threads'
import SimpleInfinite from 'patchkit-simple-infinite'
import explain from 'explain-error'
import u from 'patchkit-util'
import t from 'patchwork-translations'

// how many messages to fetch in a batch?
const DEFAULT_BATCH_LOAD_AMT = 30

// what's the avg height a message will be?
// (used in loading calculations, when trying to scroll to a specific spot. doesnt need to be exact)
const AVG_RENDERED_MSG_HEIGHT = 50

// used when live msgs come in, how many msgs, from the top, should we check for deduplication?
const DEDUPLICATE_LIMIT = 100

// how many pixels from the bottom of the screen before we load the next batch?
const LOAD_BOTTOM_DISTANCE = 2000

export default class MsgList extends React.Component {
  static contextTypes = {
    user: React.PropTypes.object.isRequired,
    events: React.PropTypes.object.isRequired,
    ssb: React.PropTypes.object.isRequired
  }
  static propTypes = {
    ListItem: React.PropTypes.func.isRequired,
    TopNav: React.PropTypes.func,
    LeftNav: React.PropTypes.func,
    RightNav: React.PropTypes.func,
    Append: React.PropTypes.func,
    Thread: React.PropTypes.func,
    listItemProps: React.PropTypes.object,
    topNavProps: React.PropTypes.object,
    leftNavProps: React.PropTypes.object,
    rightNavProps: React.PropTypes.object,
    threadProps: React.PropTypes.object,
    emptyMsg: React.PropTypes.any,
    
    batchLoadAmt: React.PropTypes.number,
    live: React.PropTypes.any,
    threads: React.PropTypes.bool,
    queueNewMsgs: React.PropTypes.bool,
    showMissing: React.PropTypes.bool,
    dateDividers: React.PropTypes.bool,
    forceRaw: React.PropTypes.bool,

    source: React.PropTypes.func,
    filter: React.PropTypes.func,
    cursor: React.PropTypes.func
  }

  constructor(props) {
    super(props)
    this.botcursor = null
    this.state = {
      msgs: [],
      newMsgQueue: [], // used to store message updates that we dont want to render immediately
      isLoading: false,
      isAtEnd: false
    }
    this.liveStream = null

    // handlers
    this.handlers = {
      onSelect: msg => {
        msg.isOpened = true
        this.setState({ msgs: this.state.msgs })
      },
      onCloseThread: msg => {
        msg.isOpened = false
        this.setState({ msgs: this.state.msgs })
      },
      onToggleBookmark: (msg) => {
        const ssb = this.context.ssb
        const events = this.context.events

        // toggle in the DB
        ssb.patchwork.toggleBookmark(msg.key, (err, isBookmarked) => {
          if (err)
            return events.emit('error', explain(err, t('error.toggleBookmark')))

          // re-render
          msg.isBookmarked = isBookmarked
          incMsgChangeCounter(msg)
          this.setState(this.state)
        })
      },
      onToggleStar: (msg) => {
        const ssb = this.context.ssb
        const events = this.context.events

        // get current state
        msg.votes = msg.votes || {}
        let oldVote = msg.votes[this.context.user.id]
        let newVote = (oldVote === 1) ? 0 : 1

        // publish new message
        var voteMsg = schemas.vote(msg.key, newVote)
        let done = (err) => {
          if (err)
            return events.emit('error', explain(err, t('error.publishVote')))

          // re-render
          msg.votes[this.context.user.id] = newVote
          incMsgChangeCounter(msg)
          this.setState(this.state)
        }
        if (msg.plaintext)
          ssb.publish(voteMsg, done)
        else {
          let recps = mlib.links(msg.value.content.recps).map(l => l.link)
          ssb.private.publish(voteMsg, recps, done)
        }
      },
      onIsread: (e) => {
        // try to find the message
        for (var i=0; i < this.state.msgs.length; i++) {
          let msg = this.state.msgs[i]
          if (msg.key === e.key) {
            msg.hasUnread = !e.value
            incMsgChangeCounter(msg)
            this.setState({ msgs: this.state.msgs })
            return
          }
        }
      },
      onFlag: (msg, reason) => {
        const ssb = this.context.ssb
        const events = this.context.events

        if (!reason)
          throw new Error('reason is required')

        // publish new message
        const voteMsg = (reason === 'unflag') // special case
          ? schemas.vote(msg.key, 0)
          : schemas.vote(msg.key, -1, reason)
        let done = (err) => {
          if (err)
            return events.emit('error', explain(err, 'Failed to publish flag'))

          // re-render
          msg.votes = msg.votes || {}
          msg.votes[this.context.user.id] = (reason === 'unflag') ? 0 : -1
          incMsgChangeCounter(msg)
          this.setState(this.state)
        }
        if (msg.plaintext)
          ssb.publish(voteMsg, done)
        else {
          let recps = mlib.links(msg.value.content.recps).map(l => l.link)
          ssb.private.publish(voteMsg, recps, done)
        }
      },
      onMsgChange: (msg) => {
        // find the message
        for (var i=0; i < this.state.msgs.length; i++) {
          if (this.state.msgs[i].key === msg.key) {
            // hold onto some prior state
            msg.changeCounter = this.state.msgs[i].changeCounter
            msg.isOpened = this.state.msgs[i].isOpened

            //replace
            this.state.msgs.splice(i, 1, msg)
            break
          }
        }
        incMsgChangeCounter(msg)
        this.setState({ msgs: this.state.msgs })
      }
    }
  }

  componentDidMount() {
    // load first messages
    var start = Date.now()
    this.loadMore({ amt: this.props.batchLoadAmt||DEFAULT_BATCH_LOAD_AMT }, () => console.log(Date.now() - start))

    // listen to isread changes
    this.context.events.on('update:isread', this.handlers.onIsread)

    // setup livestream
    if (this.props.live)
      this.setupLivestream()
  }
  componentWillUnmount() {
    // stop listeners
    this.context.events.removeListener('update:isread', this.handlers.onIsread)
    if (this.liveStream)
      this.liveStream(true, ()=>{})
  }

  loadingElement() {
    return <div className="msg-view summary">
      {t('Loading')}
    </div>
  }

  reload(newState) {
    this.setState({ isAtEnd: false, newMsgQueue: [], ...newState }, () => {
      this.botcursor = null
      this.loadMore({ amt: this.props.batchLoadAmt||DEFAULT_BATCH_LOAD_AMT, fresh: true })
    })
  }

  setupLivestream() {
    let source = this.props.source || this.context.ssb.createFeedStream
    let opts = (typeof this.props.live == 'object') ? this.props.live : {}
    opts.threads = this.props.threads
    opts.live = true
    opts.old = false
    this.liveStream = source(opts)
    pull(
      this.liveStream,
      pull.filter(msg => !msg.sync),
      pull.asyncMap((msg, cb) => threadlib.decryptThread(this.context.ssb, msg, cb)), // decrypt the message
      (this.props.filter) ? pull.filter(this.props.filter) : undefined, // run the fixed filter
      pull.asyncMap(this.processMsg.bind(this)), // fetch the thread
      pull.drain(msg => {
        if (this.props.queueNewMsgs) {
          // suppress if by the local user
          const lastMsg = threadlib.getLastThreadPost(msg)
          if (lastMsg && lastMsg.value.author === this.context.user.id)
            return this.prependNewMsg(msg)

          // queue the new msgs on the ui
          this.state.newMsgQueue.push(msg)
          this.setState({ newMsgQueue: this.state.newMsgQueue })
        } else {
          // immediately render
          msg.isLiveUpdate = true
          this.prependNewMsg(msg)
        }
      })
    )
  }

  // infinite load call
  onInfiniteLoad(scrollingTo) {
    var amt = this.props.batchLoadAmt||DEFAULT_BATCH_LOAD_AMT
    if (scrollingTo) {
      // trying to reach a dest, increase amount to load with a rough guess of how many are needed
      amt = Math.max((scrollingTo / AVG_RENDERED_MSG_HEIGHT)|0, this.props.batchLoadAmt||DEFAULT_BATCH_LOAD_AMT)
    }
    this.loadMore({ amt })
  }

  processMsg(msg, cb) {
    // fetch thread data if not already present (using `related` as an indicator of that)
    if (this.props.threads && msg.value && !('related' in msg)) {
      threadlib.getPostSummary(this.context.ssb, msg.key, cb)
    } else
      cb(null, msg) // noop
  }

  // load messages from the bottom of the list
  loadMore({ amt = 50, fresh = false } = {}, done) {
    if (this.state.isLoading || this.state.isAtEnd)
      return

    var lastmsg
    let source = this.props.source || this.context.ssb.createFeedStream
    let cursor = this.props.cursor || ((msg) => { if (msg) { return msg.value.timestamp } })
    let updatedMsgs = (fresh) ? [] : this.state.msgs
    let sourceOpts = { threads: this.props.threads, reverse: true, lt: cursor(this.botcursor) }

    if (!this.props.filter) // if we're not doing a live filter, tell the server our limit
      sourceOpts.limit = amt

    this.setState({ isLoading: true })
    pull(
      source(sourceOpts),
      pull.through(msg => { lastmsg = msg }), // track last message processed
      pull.asyncMap((msg, cb) => threadlib.decryptThread(this.context.ssb, msg, cb)), // decrypt the message
      (this.props.filter) ? pull.filter(this.props.filter) : undefined, // run the fixed filter
      pull.asyncMap(this.processMsg.bind(this)), // fetch the thread
      pull.take(amt), // apply limit
      pull.collect((err, msgs) => {
        if (err)
          console.warn(t('error.fetchingMessages'), err)

        // add msgs
        if (msgs)
          updatedMsgs = updatedMsgs.concat(msgs)

        // did we reach the end?
        var isAtEnd = false
        if (!lastmsg || (this.botcursor && this.botcursor.key == lastmsg.key) || msgs.length < amt)
          isAtEnd = true
        this.botcursor = lastmsg

        // update
        this.setState({ msgs: updatedMsgs, isLoading: false, isAtEnd: isAtEnd }, done)
      })
    )
  }

  // add messages to the top
  prependNewMsg(msgs) {
    msgs = Array.isArray(msgs) ? msgs : [msgs]
    msgs.forEach(msg => {
      var doPrepend = true

      // remove any noticeable duplicates...
      // ...or abort update if the thread is open
      // check if the message is already in the first N
      for (var i=0; i < this.state.msgs.length && i < DEDUPLICATE_LIMIT; i++) {
        if (this.state.msgs[i].key === msg.key) {
          // hold onto the change counter
          msg.changeCounter = this.state.msgs[i].changeCounter
          // is the thread open in the view?
          if (this.state.msgs[i].isOpened) {
            // update in-place
            doPrepend = false
            msg.isOpened = true
            this.state.msgs.splice(i, 1, msg)
          } else {
            // remove the old message
            this.state.msgs.splice(i, 1)
          }
          break
        }
      }
      // add to start of msgs
      incMsgChangeCounter(msg)
      if (doPrepend)
        this.state.msgs.unshift(msg)
    })
    this.setState({ msgs: this.state.msgs })
  }

  // flush queue into the page
  prependQueuedMsgs() {
    this.prependNewMsg(this.state.newMsgQueue)
    this.setState({ newMsgQueue: [] })
  }

  render() {
    const TopNav = this.props.TopNav
    const LeftNav = this.props.LeftNav
    const RightNav = this.props.RightNav
    const Thread = this.props.Thread
    const ListItem = this.props.ListItem
    const isEmpty = (!this.state.isLoading && this.state.msgs.length === 0)
    const appendEl = (this.state.isAtEnd && this.props.Append) ? <this.props.Append/> : <span/>
    const nQueued = this.state.newMsgQueue.length

    // render messages here, into an array, so we can insert date dividers
    const endOfToday = moment().endOf('day')
    var lastDate = moment().startOf('day').add(1, 'day')
    var listEls = []
    this.state.msgs.forEach((m, i) => {
      if (!m.value && !this.props.showMissing)
        return // skip missing msgs

      // render a date divider if this post is from a different day than the last
      const oldLastDate = lastDate
      lastDate = moment(m.ts || m.value.timestamp).endOf('day')
      if (this.props.dateDividers && !lastDate.isSame(oldLastDate, 'day')) {
        let label = (lastDate.isSame(endOfToday, 'day'))
          ? t('msgs.today')
          : (lastDate.isSame(endOfToday, 'month'))
            ? lastDate.from(endOfToday)
            : (lastDate.isSame(endOfToday, 'year'))
              ? lastDate.format("dddd, MMMM Do")
              : lastDate.format("LL")
        listEls.push(<hr key={m.key+'-divider'} className="labeled" data-label={label} />)
      }

      // render item
      if (m.isOpened) {
        listEls.push(
          <Thread
            key={m.key}
            id={m.key}
            onMsgChange={this.handlers.onMsgChange}
            onClose={() => this.handlers.onCloseThread(m)}
            {...this.props.threadProps}
            live />
        )
      } else {
        listEls.push(
          <ListItem
            key={m.key}
            msg={m}
            selectiveUpdate
            {...this.handlers}
            {...this.props.listItemProps}
            forceRaw={this.props.forceRaw} />
        )
      }
    })

    return <div className="msg-list">
      <div className="msg-list-items flex-fill">
        <SimpleInfinite
          id="msg-list-infinite"
          ref="container"
          infiniteLoadBeginBottomOffset={this.state.isAtEnd ? undefined : LOAD_BOTTOM_DISTANCE}
          onInfiniteLoad={this.onInfiniteLoad.bind(this)}
          loadingSpinnerDelegate={this.loadingElement()}
          isInfiniteLoading={this.state.isLoading}>
          <div className="flex" style={{position: 'relative'}}>
            { LeftNav ? <LeftNav {...this.props.leftNavProps} /> : '' }
            <div className="flex-fill">
              { TopNav ? <TopNav {...this.props.topNavProps} /> : '' }
              { nQueued ?
                <a className="new-msg-queue" onClick={this.reload.bind(this)}>{t('msgs.newUpdates', u.plural(nQueued))}</a>
                : '' }
              { this.state.msgs.length === 0 && this.state.isLoading ? <div style={{fontWeight: 300, textAlign: 'center'}}>{t('Loading')}</div> : '' }
              { isEmpty ?
                <div className="empty-msg">
                  { (this.props.emptyMsg || t('msgs.NoMessages')) }
                </div>
                :
                <ReactCSSTransitionGroup component="div" transitionName="fade" transitionAppear={true} transitionAppearTimeout={500} transitionEnterTimeout={500} transitionLeaveTimeout={1}>
                  { listEls }
                </ReactCSSTransitionGroup>
              }
              {appendEl}
            </div>
            { RightNav ? <RightNav {...this.props.rightNavProps} /> : '' }
          </div>
        </SimpleInfinite>
      </div>
    </div>
  }
}

// this little hack helps us keep track of when we update a message, and should therefore re-render it
// msg-view/card and msg-view/oneline use this number in shouldComponentUpdate to decide the answer
function incMsgChangeCounter (msg) {
  msg.changeCounter = (msg.changeCounter || 0) + 1
}
